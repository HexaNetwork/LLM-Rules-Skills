# Docker-only harness with host-owned run state

## Decision

Replace the dual local/Docker execution model with one Docker-only runtime.

The host remains the single-operator control plane. It owns durable run state,
`HarnessEngine`, the dashboard, project registration, the run's Git worktree,
commits, Docker lifecycle, and publication. Each bounded agent invocation owns
only a disposable sandbox and provider session turn.

The sandbox bind-mounts the host run worktree at `/workspace`. It never mounts
the host run directory, control checkout, credential files, or `/run-state`.
It receives only `HARNESS_RPC_URL` and `HARNESS_WORKER_TOKEN`; that short-lived,
run-scoped token advertises only the model capability.

This is a clean break:

- remove the local linked-worktree runtime;
- do not support switching runtimes;
- do not resume pre-cutover runs;
- do not retain compatibility branches solely for the old worker protocol;
- require users to finish, export, or discard old runs before upgrading.

## Target architecture

```text
Host process
  Dashboard / CLI
  Project registry
  Durable RunStore
  Model capability broker
  Docker lifecycle
  Publish/push/PR operations
          |
          | create / exec / destroy + revoke
          v
Disposable Docker sandbox
  Cursor SDK and provider sessions
  Agent tool execution
  /workspace (host worktree bind)
          |
          | HTTPS
          v
Cursor provider
```

Remote inference occurs at the provider. The provider client and all local
tool execution remain in the container so a provider-generated shell, read,
or write operation cannot execute against the host filesystem.

## Security and capability model

Docker is the primary filesystem and process boundary:

- mount only the assigned host worktree at `/workspace`;
- never mount the control checkout, harness home, host run directory, Docker
  socket, host home, credential paths, or arbitrary bind paths;
- use a read-only root filesystem, a non-root worker, dropped capabilities,
  `no-new-privileges`, PID/memory/CPU limits, and private process namespaces;
- publish worker RPC only to a random host loopback port;
- retain explicit network policy because bridge networking is not an
  exfiltration boundary.

Cursor's sandbox remains enabled as provider-level defense in depth, but the
harness must stop parsing arbitrary tool argument text as filesystem paths.
Remove the generic `outside-workspace` argument heuristic. A string such as
`/t claim` is application content, not evidence of filesystem access.

Keep only controls with unambiguous semantics:

- role-level `allowTools: false`;
- container mount and privilege validation before startup;
- exact protection for harness-created paths that actually exist inside
  `/workspace`, if any;
- bounded command/resource/network policy;
- install observation and approval where product policy requires it.

The Cursor API key must not be placed in run state, the workspace, image
layers, Docker command arguments, environment, or mounts. The host provider
proxy holds the credential and exposes only provider operations required by
the sandbox.

The real Cursor probe has now rejected that approach: delegated reads were
denied, while the direct phase had no conclusive denial and emitted exact
credential bytes. The old diagnostic did not retain enough redacted metadata
to locate those bytes within the tool result versus another SDK event. The
worker and agent tools share one UID, so file modes cannot repair this boundary.
Production secret-file mounting is deleted; the host provider proxy is the
only production credential mechanism.

## Phase 1: Freeze the architecture

> Historical delivery notes below describe the rejected long-lived worker/state
> RPC design. The accepted implementation keeps workflow and durable state on
> the host and uses model-only disposable sandboxes; those notes are not
> compatibility requirements.

Supersede ADR 0015 with the Docker-only topology and record these invariants:

- the host is authoritative for durable state;
- the container is authoritative for run advancement while it is active;
- state mutations use compare-and-swap revision semantics;
- one advancing worker exists per run;
- the worker can be destroyed and recreated against the retained workspace;
- agent execution never receives host filesystem paths;
- no agent container mounts `/run-state` or an equivalent host state path;
- old run formats are unsupported after the cutover.

Document the failure model before implementation: host restart, worker
restart, dropped RPC response, duplicate mutation, stale worker, cancellation,
workspace retained without a worker, and state retained without a workspace.

## Phase 2: Introduce a state port

Decouple `HarnessEngine` from direct `RunStore` filesystem ownership.

Define a `RunStatePort` used by the engine for:

- loading the current run snapshot;
- compare-and-swap state updates by expected revision;
- appending events and session steps idempotently;
- reading and writing packets and bounded artifacts;
- cancellation and stop flags;
- leases/heartbeats for the active advancing worker.

Provide two adapters temporarily during development:

- `FilesystemRunStatePort`, used by focused unit tests and host services;
- `RpcRunStatePort`, used by every production worker container.

Do not expose arbitrary file read/write RPC. Model operations by domain object
and artifact identifier so the worker cannot turn the state service into a
general host filesystem proxy.

Use request IDs and idempotency keys for every mutation. Reject stale
revisions explicitly rather than silently overwriting newer state.

## Phase 3: Add the host state service

Extend the host server with a worker-facing API separate from dashboard
routes. Authenticate every request with a per-run, short-lived credential and
bind it to exactly one run ID and protocol version.

Required operations:

- worker bootstrap: frozen config, workspace identity, current revision;
- state snapshot read and compare-and-swap mutation;
- event/session-step append;
- packet/artifact get and put with type and size limits;
- heartbeat, lease acquisition/renewal, cancellation check;
- export-ready notification and worker shutdown acknowledgement.

The host writes all durable files. Continue using atomic replace and fsync
behavior already provided by the store. The API must never accept caller-
selected host paths.

Add audit fields to each worker mutation: run ID, worker instance ID, request
ID, expected revision, resulting revision, operation, and timestamp. Never log
credentials or artifact bodies.

## Phase 4: Make the worker stateless with respect to host files

Change worker bootstrap to accept only:

- run ID;
- worker instance ID;
- host state-service endpoint;
- scoped worker credential;
- provider credential mechanism;
- `/workspace` identity and expected base SHA.

Remove worker reads of `/run-state/config.json`, `workspace.json`, execution
secrets, probe stamps, and state files. Fetch the equivalent typed bootstrap
document from the host.

Construct `HarnessEngine` with `RpcRunStatePort`. Keep provider sessions and
in-process cancellation in the long-lived worker. Treat provider-session IDs
as durable domain data written through the state port.

On worker recreation, acquire the run lease, validate workspace identity and
HEAD, reload the current state, and resume only operations that are explicitly
recoverable. Never infer completion from an RPC timeout.

## Phase 5: Reduce the container mounts and protocols

Update the hardened container specification so the only persistent mount is:

```text
named workspace volume -> /workspace (read/write)
```

Remove the `/run-state` bind mount and its allowlist exception. Delete the RPC
and Cursor secret paths under `execution-secrets/` once no supported code uses
them.

Replace the current host-to-worker bearer token file with a bootstrap secret
that is not part of the workspace or durable run directory. Rotate it whenever
the worker is recreated. Prefer a host-initiated bootstrap handshake so the
credential does not need to survive container startup.

Version the new bidirectional protocol independently from the old worker RPC
contract. Fail closed on harness or protocol mismatch and show the mismatch in
CLI/UI diagnostics.

## Phase 6: Remove semantic path gating

Delete Docker-runtime use of `prohibitedAgentPathAccess` and its generic
absolute-path regex. Keep the provider step callback for bounded activity
summaries, install observation, cancellation, and CreatePlan harvesting.

Expand the real isolation probe to demonstrate behavior rather than inspect
prompt text:

- write succeeds under `/workspace`;
- the host control checkout is absent;
- the host run directory is absent;
- the Docker socket is absent;
- provider and worker credentials cannot be read by agent tools;
- an attempted read of `/etc/passwd` is handled according to the chosen SDK
  sandbox policy without relying on argument-string parsing;
- harmless slash-prefixed domain text such as `/t claim` does not cancel a
  provider run;
- delegated `task` calls remain inside the same workspace boundary.

If delegated tasks do not inherit the proven sandbox boundary, disable the
`task` capability explicitly by tool name. Do not try to infer its safety from
the natural-language task prompt.

## Phase 7: Remove the local runtime and compatibility surface

Make Docker readiness a startup requirement rather than a project option.
Remove:

- `execution.runtime: local` and runtime switching code;
- linked-worktree execution paths and local-agent workspace negotiation;
- local-runtime settings and UI controls;
- migration logic whose only purpose is resuming old local or `/run-state`
  worker runs;
- tests that assert dual-runtime behavior.

Keep host-side temporary/quarantine work only where required for safe bundle
inspection and publication. It must never become an agent execution path.

At upgrade, detect existing active runs and stop with an actionable message:
finish/export with the previous version or explicitly discard them. Do not
silently reinterpret old state.

## Phase 8: Recovery and lifecycle behavior

Implement and test the following lifecycle:

1. Host creates run state and a workspace volume.
2. Host seeds the exact base SHA into `/workspace`.
3. Host starts the worker with scoped bootstrap credentials.
4. Worker validates workspace identity and acquires the run lease.
5. Worker advances the run and persists every transition through the state
   service.
6. UI/CLI reads authoritative state from the host store.
7. Cancellation is recorded by the host and delivered to the worker; provider
   cancellation remains best effort but state transitions remain deterministic.
8. Worker prepares a result bundle in a defined workspace transport area and
   reports its digest.
9. Host imports/quarantines/publishes the result.
10. Cleanup removes the container first and the workspace volume only after
    durable export or explicit discard.

Use a lease timeout plus worker-instance fencing token so a recovered worker
cannot race a stale instance.

## Test plan

### Unit

- state-port contract tests run against filesystem and RPC adapters;
- compare-and-swap conflicts, idempotent retries, and fencing tokens;
- scoped authentication cannot cross run IDs;
- container spec contains only the workspace mount;
- no secret appears in argv, image metadata, logs, workspace, or child env;
- slash-prefixed non-path prompt text is accepted;
- explicit role tool denial still works.

### Integration

- host state service plus fake worker across real HTTP;
- worker restart resumes from host state without `/run-state`;
- lost response followed by retry does not duplicate events or revisions;
- stale worker mutations are rejected after lease replacement;
- dashboard actions and worker advancement observe the same revision;
- cancellation works during a provider call and deterministic command.

### Real Docker

- inspect mounts and assert `/run-state` is absent;
- run the isolation probe through actual provider-style tools;
- stop/remove/recreate the worker against the retained workspace volume;
- restart the host and reconnect/rebootstrap the worker;
- verify provider-backed reflection and grilling using content containing
  `/t claim`;
- verify a delegated task cannot access host state or credentials;
- export a commit and confirm the control checkout remained unchanged.

### Acceptance

- a normal Emperor run progresses from creation to `awaiting_input`;
- answer/confirm/retry/cancel work through the UI and CLI;
- implementation, verification, review, and export complete in Docker;
- worker and host restarts preserve deterministic run state;
- no production path supports host-local agent execution.

## Delivery order (superseded)

[ADR 0017](../adr/0017-cordis-composed-docker-runtime.md) replaces the
constructor-driven delivery topology with one Cordis-composed sequence:

1. Freeze the lifecycle, trust, profile, and golden-path contracts.
2. Land Cordis boot, typed services, registries, and fail-loud diagnostics.
3. Compose the headless host control plane and sole run-lifecycle owner.
4. Compose the immutable environment, Git-bundle source, named volume, secured
   Docker runtime, and credential boundary.
5. Compose the worker over RPC state, effect-scoped roles/phases, provider,
   knowledge, verification, commands, and result export.
6. Prove restart recovery, fencing, ordered teardown, host publication, and
   control-checkout integrity at every lifecycle boundary.
7. Make the real-Docker CLI-only golden path blocking.
8. Switch CLI/UI to the host profile, reject pre-cutover active runs, then
   delete the local runtime, generated-image pipeline, `/run-state`,
   `RpcRunStore`, and compatibility facades.

No legacy deletion or default switch occurs before the blocking Docker golden
path passes repeatedly from clean state.

## Completion criteria

- Every bounded agent invocation creates, executes, and destroys a sandbox and
  revokes its capability; no container is reattached.
- Agent containers mount only the host run worktree at `/workspace`.
- Durable run state and execution secrets remain host-owned and are not visible
  through the container filesystem.
- Provider SDK sessions and all local agent tools execute inside Docker.
- Worker environment/arguments/filesystem/mounts contain no durable provider or
  Git credential; the only harness capability configuration is
  `HARNESS_RPC_URL` and `HARNESS_WORKER_TOKEN`.
- Host services own task commits, push, and publication.
- The harness performs no natural-language path inference over tool arguments.
- Docker lifecycle and explicit role policy are the capability controls.
- Worker recreation and host restart recover without state corruption or
  duplicate transitions.
- The complete Emperor workflow passes with slash-prefixed Minecraft commands
  in its feature brief.
- Local execution and pre-cutover run resumption are removed from supported
  behavior.

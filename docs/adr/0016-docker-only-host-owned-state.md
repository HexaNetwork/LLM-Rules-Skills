# ADR 0016: Docker-only runtime with host-owned run state

## Status

Accepted; **supersedes [ADR 0015](0015-docker-isolated-runs.md)**. Extends the per-run workspace identity of [ADR 0010](0010-per-run-worktrees.md) and the external control plane of [ADR 0011](0011-external-harness-home.md). Implementation follows the [Docker-only state service plan](../plans/docker-only-state-service.md).

## Context

ADR 0015 introduced Docker as an opt-in execution runtime beside the local linked-worktree runtime, and mounted the run's durable state directory into the worker container at `/run-state`. Operating both runtimes doubled every lifecycle, recovery, and security code path, and the `/run-state` mount gave agent-driven processes direct filesystem access to durable control-plane state: state files, frozen config, execution secrets, and the RPC token all sat on a volume the worker could read and write arbitrarily.

The dual model also forced the harness to guess at agent intent. Because the container was not treated as the hard boundary, the harness layered a heuristic that parsed tool argument text for absolute paths (`prohibitedAgentPathAccess`), which misclassified application content such as `/t claim` as filesystem access.

## Decision

There is exactly one agent execution runtime: a disposable Docker sandbox bound
to a host-owned run worktree. Runtime switching and pre-cutover run resumption
are removed. Users finish, export, or discard old runs before upgrading.

### Topology

- The **host** owns `HarnessEngine` advancement, durable `RunStore`, the run's Git
  worktree, commits, Docker lifecycle, and publish/push/PR operations.
- Every bounded agent invocation creates a fresh sandbox, bind-mounts that run's
  host worktree at `/workspace`, executes once, then destroys the container and
  revokes its capability. Containers are never reattached.
- The sandbox receives only `HARNESS_RPC_URL` and `HARNESS_WORKER_TOKEN` as
  harness capability configuration. **There is no `/run-state` or credential
  mount** and no equivalent host control path inside the container.
- Remote inference happens at the provider; the provider client and all local tool execution stay inside the container, so a provider-generated shell/read/write operation cannot reach the host filesystem.

### Invariants

1. **The host is authoritative for durable state.** All durable files (state, events, sessions, packets, config, secrets) are written by the host using the store's existing atomic-replace and journal recovery behavior.
2. **The host is authoritative for run advancement.** Dashboard and CLI
   mutations dispatch to the host lifecycle owner.
3. **Every agent invocation is disposable.** Its sandbox and capability are
   bounded to one invocation; retained provider IDs may resume remotely, but a
   container is never resumed or reattached.
4. **The worker has no durable credential.** The Cursor key remains in the host
   provider proxy. The worker token is short-lived, run-scoped, and model-only.
5. **Git is host-owned.** Worktree creation, task commits, push, and publication
   never move into the sandbox.
6. **Agent execution sees the worktree only as `/workspace`.** No host path is
   placed in worker configuration.
7. **No agent container mounts `/run-state` or an equivalent host state path.** The state API models operations by domain object and artifact identifier; it never accepts caller-selected host paths and never offers arbitrary file read/write.
8. **Old run formats are unsupported after the cutover.** No migration or resume path for pre-cutover (local-runtime or `/run-state`-worker) runs.

### State access contract

`HarnessEngine` uses the host `RunStore`. Worker capability routes are restricted
to provider bootstrap/renewal; durable snapshot, CAS, lease, knowledge, and
progress operations are not advertised to sandboxes.

### Failure model

| Failure | Behavior |
|---------|----------|
| **Host restart** | Durable state and the registered worktree are already on disk. No container is rediscovered or reattached. |
| **Sandbox crash** | The host destroys the failed sandbox, revokes its capability, and a retry creates a new sandbox against the same worktree. |
| **Dropped RPC response** | The caller retries with the same idempotency key. The host recognizes the applied mutation and returns the recorded result without re-applying it — no duplicate events, no extra revision. |
| **Duplicate mutation** | Idempotency keys make retries safe; event appends dedup by key; compare-and-swap rejects a second writer whose expected revision has moved. |
| **Stale worker** | A replaced worker holds an old fencing token. Once a new instance acquires the lease, the stale token is lower than the latest issued token and every state mutation from the stale worker is rejected with a fencing error. |
| **Cancellation** | Recorded by the host as a durable flag and delivered to the worker; provider cancellation remains best effort, but state transitions stay deterministic (cancel is a host-recorded transition, not an inference from process death). |
| **Workspace retained without a worker** | Normal state: sandboxes exist only while bounded work is executing. |
| **State retained without a workspace** | A missing registered worktree blocks; the host never silently recreates or redirects agent work to the control checkout. |

### Security and capability model

Docker is the primary filesystem and process boundary: the assigned host
worktree is the sole writable bind at `/workspace`; only public trust material
may be mounted read-only under `/run/agent-harness-public/`. Control state,
credential paths, Docker socket, host home, and control checkout are rejected.

Worker containers run with `--security-opt seccomp=unconfined`. The Cursor SDK sandbox helper builds its per-tool filesystem boundary inside an unprivileged user namespace, and Docker's default seccomp profile answers `unshare(CLONE_NEWUSER)` with EPERM whenever CAP_SYS_ADMIN is absent. Under the default profile the SDK silently downgrades every tool call to `insecure_none`, which removes the in-container boundary that keeps agent tools away from the mounted credential. Capabilities stay fully dropped, so this trades a wider syscall surface for the sandbox the credential proof depends on.

The Cursor API key is never placed in run state, the workspace, image layers,
arguments, environment, or mounts. A host provider proxy retains it and issues
only a short-lived broker capability to the sandbox.

The harness stops parsing tool argument text as filesystem paths: the generic `outside-workspace` argument heuristic is removed. Remaining controls have unambiguous semantics: role-level `allowTools: false`, container mount/privilege validation, bounded command/resource/network policy, and install observation. If delegated `task` calls do not inherit the proven sandbox boundary, the capability is disabled by tool name.

## Consequences

- `execution.runtime: local`, runtime switching, linked-worktree execution, and old-run resume logic are removed; Docker readiness becomes a startup requirement.
- The host exposes only the model-provider bootstrap operations required by the
  sandbox. Capability names are not advertised ahead of implemented need.
- The sandbox process receives a scoped endpoint/token pair and always uses
  `/workspace`; host worktree paths stay in host-owned metadata.
- `/run-state`, secret files, long-lived worker sessions, named clone volumes,
  and workflow-RPC compatibility are deleted rather than adapted.
- ADR 0015's dual-runtime and `/run-state` decisions are retained below for history only.

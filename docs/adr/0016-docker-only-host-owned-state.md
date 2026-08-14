# ADR 0016: Docker-only runtime with host-owned run state

## Status

Accepted; **supersedes [ADR 0015](0015-docker-isolated-runs.md)**. Extends the per-run workspace identity of [ADR 0010](0010-per-run-worktrees.md) and the external control plane of [ADR 0011](0011-external-harness-home.md). Implementation follows the [Docker-only state service plan](../plans/docker-only-state-service.md).

## Context

ADR 0015 introduced Docker as an opt-in execution runtime beside the local linked-worktree runtime, and mounted the run's durable state directory into the worker container at `/run-state`. Operating both runtimes doubled every lifecycle, recovery, and security code path, and the `/run-state` mount gave agent-driven processes direct filesystem access to durable control-plane state: state files, frozen config, execution secrets, and the RPC token all sat on a volume the worker could read and write arbitrarily.

The dual model also forced the harness to guess at agent intent. Because the container was not treated as the hard boundary, the harness layered a heuristic that parsed tool argument text for absolute paths (`prohibitedAgentPathAccess`), which misclassified application content such as `/t claim` as filesystem access.

## Decision

There is exactly one execution runtime: a per-run Docker container. The local linked-worktree runtime, runtime switching, and pre-cutover run resumption are removed. Users finish, export, or discard old runs before upgrading.

### Topology

- The **host** is the single-operator control plane: dashboard/CLI, project registry, durable `RunStore`, Docker lifecycle, workspace seed/result bundle transport, and publish/push/PR operations.
- The **per-run container** owns `HarnessEngine` advancement, the provider SDK and agent sessions, repository tools, and the isolated workspace at `/workspace` (a named read-write volume, the container's only persistent mount).
- The worker reads and mutates durable state exclusively through an authenticated, versioned host state API. **There is no `/run-state` mount** and no equivalent host state path inside the container.
- Remote inference happens at the provider; the provider client and all local tool execution stay inside the container, so a provider-generated shell/read/write operation cannot reach the host filesystem.

### Invariants

1. **The host is authoritative for durable state.** All durable files (state, events, sessions, packets, config, secrets) are written by the host using the store's existing atomic-replace and journal recovery behavior.
2. **The container is authoritative for run advancement while it is active.** Dashboard reads observe host state; dashboard mutations for an active run are delivered to the worker.
3. **State mutations use compare-and-swap revision semantics.** Every mutation carries the expected revision; a stale revision is rejected explicitly, never silently overwritten.
4. **One advancing worker exists per run**, enforced by a host-issued lease with a monotonic fencing token per worker instance.
5. **The worker can be destroyed and recreated against the retained workspace.** Recreation revalidates workspace identity and HEAD, reacquires the lease (new fencing token), reloads state, and resumes only explicitly recoverable operations.
6. **Agent execution never receives host filesystem paths.** Bootstrap delivers typed domain documents (frozen config, workspace identity, current revision), not paths.
7. **No agent container mounts `/run-state` or an equivalent host state path.** The state API models operations by domain object and artifact identifier; it never accepts caller-selected host paths and never offers arbitrary file read/write.
8. **Old run formats are unsupported after the cutover.** No migration or resume path for pre-cutover (local-runtime or `/run-state`-worker) runs.

### State access contract

`HarnessEngine` depends on a `RunStatePort` instead of owning `RunStore` filesystem access: snapshot load, compare-and-swap by expected revision, idempotent event/session-step append, packet/artifact read-write by typed identifier, cancellation/stop flags, and leases/heartbeats. Every mutation carries a request ID and an idempotency key. Two adapters exist: `FilesystemRunStatePort` (host services, focused unit tests) and `RpcRunStatePort` (production worker containers). Contract tests run against both.

### Failure model

| Failure | Behavior |
|---------|----------|
| **Host restart** | Durable state is already on disk (atomic replace + transition journal). On restart the host reloads from the store, rediscovers containers by stable workspace identity, and reconnects or recreates workers. No state is lost; an interrupted transition is completed by journal recovery. |
| **Worker restart / crash** | The workspace volume and host state survive. The host recreates the worker against the retained workspace; the new instance validates workspace identity and HEAD, acquires the lease (new fencing token), reloads the snapshot, and resumes only recoverable operations. Completion is never inferred from an RPC timeout. |
| **Dropped RPC response** | The caller retries with the same idempotency key. The host recognizes the applied mutation and returns the recorded result without re-applying it — no duplicate events, no extra revision. |
| **Duplicate mutation** | Idempotency keys make retries safe; event appends dedup by key; compare-and-swap rejects a second writer whose expected revision has moved. |
| **Stale worker** | A replaced worker holds an old fencing token. Once a new instance acquires the lease, the stale token is lower than the latest issued token and every state mutation from the stale worker is rejected with a fencing error. |
| **Cancellation** | Recorded by the host as a durable flag and delivered to the worker; provider cancellation remains best effort, but state transitions stay deterministic (cancel is a host-recorded transition, not an inference from process death). |
| **Workspace retained without a worker** | Normal quiescent state (paused, awaiting input, finished). The workspace volume is retained until durable export or explicit discard; a new worker can be created against it at any time. |
| **State retained without a workspace** | A missing volume blocks with a recoverable diagnostic; the host never silently reseeds. Cleanup removes the container first and the volume only after durable export or explicit discard. |

### Security and capability model

Docker is the primary filesystem and process boundary: only the named workspace volume is mounted; read-only root filesystem, non-root worker, dropped capabilities, `no-new-privileges`, resource limits, and worker RPC published only to a random host loopback port. Explicit network policy is retained because bridge networking is not an exfiltration boundary.

The Cursor API key is never placed in run state, the workspace, image layers, command arguments, or project-command environments; it is bootstrapped through a read-only secret file outside `/workspace` (preferred) or a host provider proxy, and stripped from every child-process environment.

The harness stops parsing tool argument text as filesystem paths: the generic `outside-workspace` argument heuristic is removed. Remaining controls have unambiguous semantics: role-level `allowTools: false`, container mount/privilege validation, bounded command/resource/network policy, and install observation. If delegated `task` calls do not inherit the proven sandbox boundary, the capability is disabled by tool name.

## Consequences

- `execution.runtime: local`, runtime switching, linked-worktree execution, and old-run resume logic are removed; Docker readiness becomes a startup requirement.
- The host gains a worker-facing state API, authenticated per run with a short-lived credential bound to one run ID and protocol version, with audit fields (run ID, worker instance ID, request ID, expected/resulting revision, operation, timestamp) on every mutation. Credentials and artifact bodies are never logged.
- Worker bootstrap accepts only: run ID, worker instance ID, state-service endpoint, scoped credential, provider credential mechanism, and `/workspace` identity with expected base SHA.
- The new bidirectional protocol is versioned independently from the old worker RPC contract; harness/protocol mismatch fails closed and surfaces in CLI/UI diagnostics.
- `/run-state` removal is gated on the state service, credential bootstrap, recovery path, and the real isolation probe all passing; local-runtime removal is gated on the Docker acceptance lane covering the complete lifecycle.
- ADR 0015's dual-runtime and `/run-state` decisions are retained below for history only.

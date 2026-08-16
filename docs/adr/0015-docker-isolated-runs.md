# ADR 0015: Docker-isolated execution runtime for agent harness runs

## Status

**Superseded** by [ADR 0018](0018-fresh-modular-harness.md). Isolation and
topology are now: one host process, one Linux container per run, worktree bind
at `/workspace`, `CURSOR_API_KEY` in the container env, no frozen run settings,
no `/run-state` mount, no dual local/Docker runtime. Kept for decision history.

Was previously superseded by [ADR 0016](0016-docker-only-host-owned-state.md)
and [ADR 0017](0017-cordis-composed-docker-runtime.md), which 0018 also
supersedes.

Was: Accepted; extends [ADR 0010](0010-per-run-worktrees.md) and [ADR 0011](0011-external-harness-home.md). Local linked worktrees remain the default runtime.

## Context

ADR 0010 separated the control checkout from a per-run execution root via Git linked worktrees. That gives concurrent, restartable runs without switching the operator tree, but the agent and project commands still execute on the host filesystem sharing the operator's privileges, credentials, and tooling.

Operators need a stronger isolation boundary for untrusted project commands, package installs, and agent tool use—without changing the LLM provider contract, abandoning durable run state, or mounting the control repository into the worker.

Docker is therefore an **execution runtime**, not an agent/LLM provider. `agent.provider` continues to select Cursor (or a future provider). `execution.runtime` selects where that provider and the harness worker run: `local` (linked worktree) or `docker` (container-local clone).

## Decision

### Trust boundaries

- **Host control plane** owns the dashboard, project registry, authoritative Git repository, container lifecycle, seed/result bundle transport, quarantine import, push, and PR creation.
- **Per-run worker** owns `HarnessEngine` advancement, Cursor SDK sessions, cancellation, deterministic commands, Git against the run workspace, and repository-intelligence processes.
- Never mount into a run container: the control checkout, complete harness home, sibling run state, host home, Docker socket, or provider credentials intended for project commands.
- Mount only that run’s durable state directory (at `/run-state`) and one named RW workspace volume (at `/workspace`).

### Host / worker split

- One long-lived worker process and Cursor SDK instance per run container preserves provider-session reuse and in-process cancellation.
- Host↔worker communication is authenticated loopback RPC. Host mutation routes for Docker runs proxy to the worker; host reads may continue from the durable run directory.
- Runtime switching mid-run is forbidden. Docker is opt-in per project and frozen into the run’s `config.json` at creation. Existing `git-worktree` runs resume on the local runtime.

### Dual confinement (container + Cursor sandbox)

- **Docker** confines the run to a container: process, filesystem mounts, resource limits, and (policy-dependent) network namespace.
- **Cursor’s Linux sandbox** confines agent tools to `/workspace` and must not be able to read or write `/run-state` (or the RPC secret). Docker-mode runs may start agents only after fail-closed isolation probes prove that boundary.
- These layers are complementary: container isolation limits blast radius on the host; the SDK sandbox limits agent tools inside the container.

### Generated-image contract

- Project toolchain images are generated deterministically from allowlisted, digest-pinned bases plus a maintained worker image. Project source is not baked into the image; the seed clone and dependency prep happen in the run volume.
- First build, profile change, or Dockerfile edit requires operator approval. Every `FROM` is validated against an exact allowlist; privileged setup, Docker socket access, and secret-bearing image args are rejected.

### Bundle transport

- The host creates a hashed seed bundle under the run’s `transport/` directory; the worker initializes `/workspace` from that bundle at exactly `baseSha` with no remote and no host path.
- Results return as a hashed result bundle. The host verifies, quarantines, validates ancestry/limits, then atomically promotes a delivery ref. Credentials for push/PR never enter the container.

### Network policy

- Build/install networking is separate from runtime networking (`execution.docker.network.packageInstall` vs `runtime`). Runtime needs Cursor provider egress, so `network: none` is not the default.
- MVP runtime network mode is explicit `bridge` (filesystem isolation, **not** exfiltration-proof). Provider/package-registry allowlisted proxy is a later hardening option.
- Never privileged, host PID/IPC/network namespaces, Docker socket mounts, or arbitrary extra binds.

### Secrets

- Per-run RPC token and worker `CURSOR_API_KEY` are run-state secret files under `/run-state/execution-secrets/` (not container `-e` env). Project commands continue to use a minimal environment that strips provider credentials.

### Recovery

- Persist stable Docker workspace identity (`containerName`, volume name, image digest, `baseSha`, seed-bundle hash, generation). Discover ephemeral container IDs and host ports; do not trust them as sole identity.
- Missing containers may be recreated against a retained named volume. Missing volumes block with recoverable diagnostics rather than silently reseeding.
- Cleanup is conservative: stop worker, remove container, remove volume only after import/publish durability (or explicit discard). Orphan reconciliation inspects only harness-labeled containers.

### Local default preserved

- `execution.runtime` defaults to `local`. Linked worktrees under ADR 0010/0011 remain the default and the resume path for existing runs.
- Docker mode adds a `docker-clone` workspace kind behind a `WorkspaceProvisioner` port; local mode continues to wrap `WorktreeManager`.

## Consequences

- Configuration gains a top-level `execution` policy hashed into frozen run configs (runtime stamps live in `execution.json` / workspace metadata, not the policy hash).
- Application services depend on `WorkspaceProvisioner` rather than constructing `WorktreeManager` directly.
- Host path helpers distinguish native control/state roots from worker constants `/run-state` and `/workspace`.
- Installers, readiness probes, image pipeline, worker RPC, clone provisioning, and bundle import land in follow-up slices; this ADR freezes the architecture before those land.
- Bridge networking must not be marketed as egress isolation until an allowlisted proxy mode exists.

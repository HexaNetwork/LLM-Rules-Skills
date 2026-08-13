# ADR 0011: External harness home and zero-footprint target repositories

## Status

Accepted; extends [ADR 0010](0010-per-run-worktrees.md). Sibling linked worktrees remain the local-runtime default; container isolation is deferred to [ADR 0015](0015-docker-isolated-runs.md).

## Context

ADR 0010 separated the control root from the run execution root, but harness configuration, durable state, guidance, and worktrees still lived under or beside the target repository (typically `.agent-harness/` and repository-local `agent-harness.config.*`). That mixes project source with tool installation and runtime data: noisy working trees, accidental agent edits to harness files, clone-coupled machine paths, and cleanup that must distinguish project files from tool-owned files.

## Decision

- **Zero-footprint targets.** New projects receive no checked-in harness manifest and no repository-local `.agent-harness` directory. The target repository is an execution/identity root only.
- **External harness home.** Resolve a platform-appropriate durable home (`AGENT_HARNESS_HOME` or CLI/config override), with defaults:
  - Windows: non-roaming local application data (`%LOCALAPPDATA%/agent-harness`)
  - macOS: Application Support (`~/Library/Application Support/agent-harness`)
  - Linux: `$XDG_STATE_HOME/agent-harness`, else `~/.local/state/agent-harness`
- **Explicit path contracts.** Compose `HarnessHomePaths` and per-project `ProjectPaths` (including an independent `worktreeRoot`). Derive run-bound `HarnessPaths` (`controlRoot`, `stateRoot`, `workspaceRoot`) from registration + `workspace.json`; services do not reconstruct roots ad hoc.
- **Sibling worktrees by default.** New Git-enabled runs on the local execution runtime create linked worktrees under `<parent>/<repository-name>-worktrees/<safe-run-id>`, outside the control root, with an explicit project-level `worktreeRoot` override. Validate ownership and containment before create/remove. Git's required `.git/worktrees/<name>` administrative metadata under the common Git directory remains acceptable and is not harness state. Docker mode (ADR 0015) does not replace this sibling-worktree layout for `execution.runtime: local`.
- **Project registration.** Project identity lives in the harness home (`projects/<project-key>/registration.json`). Discovery uses `--project`, `--repository`, or the current directory resolved to a registered control root. Do not silently register during run start/advance. Moved checkouts use explicit `project relink`.
- **External configuration and frozen components.** Configuration and reusable rules/skills/workflows/agents resolve from the harness home (project then global then packaged). Freeze effective orchestration inputs into the run directory at creation; resume uses that snapshot.
- **Agent isolation boundary.** Agents receive the run worktree as their writable workspace. Harness-home paths are not exposed as writable roots. Strict isolation refuses providers that cannot restrict the writable workspace.
- **Migration is explicit and non-destructive.** `migrate-home` copy-validates repository-local installs into the external home, leaves originals until a separate cleanup, and keeps a bounded legacy compatibility path for in-progress runs.

## Consequences

- New registered projects no longer write harness-owned config, state, guidance, locks, indexes, or worktrees beneath the target control root (aside from Git-owned worktree metadata).
- Operators discover and manage worktrees beside the repository or under an explicit override volume.
- Existing repository-local installs continue until migrated; automatic deletion of legacy data is out of scope.
- Independent clones are distinct projects unless the operator links or aliases them.
- OS-level sandboxing of arbitrary project commands via an opt-in Docker execution runtime is specified in ADR 0015; local mode continues to use sibling linked worktrees and Cursor sandboxing where available.

### Migration rollback

`agent-harness migrate-home` is copy-validate only until `--cleanup` is passed. Before cleanup, rollback is: keep the original repository-local `agent-harness.config.*` / `.agent-harness/` paths and continue using legacy `--config` discovery; optionally remove the new external registration with `agent-harness project remove` after confirming no new external runs must be retained.

# ADR 0010: Per-run worktrees with control/execution roots and late delivery branches

## Status

Accepted; supersedes the shared-working-tree portion of [ADR 0009](0009-operational-intervention-and-budgets.md). Local linked worktrees remain the default execution runtime; the deferred container isolation boundary is recorded in [ADR 0015](0015-docker-isolated-runs.md).

## Context

ADR 0009 correctly required exclusive ownership of the repository while a run mutates Git state, but it chose the **shared working tree** as the lock grain. That decision serializes whole runs, forces branch switches at start, and makes fingerprints and `changedFiles()` sensitive to unrelated activity in the operator checkout or in another run.

The harness needs concurrent, restartable runs that leave the operator's checkout untouched, while still detecting interference **inside** a run's own files.

## Decision

- **Separate control root from execution root.** The project checkout is the **control root**: it owns configuration defaults and durable harness state discovery. Each Git-enabled run receives a registered Git worktree as its **execution root**. Runtime composition exposes explicit paths (`controlRoot`, `stateRoot`, `workspaceRoot`) rather than overloading `repositoryRoot` to mean both locations.
- **Create worktrees at run start, detached at an immutable `baseSha`.** Resolve the selected local base branch once, reserve `<stateRoot>/worktrees/<safeRunId>`, and run `git worktree add --detach <path> <baseSha>`. Persist versioned `workspace.json` (`RunWorkspace`) before agents or indexing touch the tree. Detached `HEAD` is intentional; the registered worktree keeps that tip reachable while the run exists. When `execution.runtime` is `local` (the default), this linked-worktree path remains authoritative; Docker-isolated clones are a separate opt-in runtime under ADR 0015 and must not replace local worktrees for existing or default runs.
- **Create the delivery branch late.** Do not switch to or create `branchPrefix/<runId>` at start. Create a human-readable branch only when publication needs a named ref (normally push/PR), derived from the confirmed feature title plus a short run id. Legacy/resumed runs that already have a branch retain it. `RunState.branchName` remains a delivery summary; `workspace.json` is authoritative for operational mapping.
- **Treat workspace evidence as run-local.** Replace cross-run coordination via a shared tree fingerprint with structured `WorkspaceEvidence` (HEAD, index identity, status digest, bounded paths, versioned fingerprint). A mismatch means external interference in **this** run's worktree.
- **Narrow locking.** Retain the per-run lock for state/config/workspace mutation. Replace the long-held repository lock for normal advancement with a short workspace-administration lock around shared worktree metadata mutations (add/remove/rename/shared-index updates). Legacy runs without `workspace.json` remain `legacy-shared` and keep ADR 0009 repository-locking semantics until migrated.
- **Keep cleanup explicit and conservative.** Never prune unpublished run worktrees implicitly; cleanup verifies registration, cleanliness, and publication/discard state first.

## Consequences

- New Git-enabled runs no longer switch the operator checkout or create a delivery branch at start.
- Independent runs can advance without observing each other's working trees; fingerprints diagnose run-local divergence.
- ADR 0009's cancellation, usage ceilings, and reviewer/implementer session rules remain in force. Only the "repository is the lock grain for all mutating work" rule is superseded for worktree-backed runs.
- Disk use and cleanup become operational concerns; Windows path sanitization and Git version checks (≥ 2.5 for `git worktree add --detach`) are required before creation.
- Migration must reopen runs missing `workspace.json` as `legacy-shared` rather than silently creating worktrees.
- Stronger host isolation (container boundary, generated images, bundle import) is intentionally out of scope here and is specified in ADR 0015 without changing local worktree semantics.

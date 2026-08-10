# Per-run worktrees and run-local integrity plan

**Status:** accepted  

**Scope:** `packages/agent-harness`  
**Origin:** worktree, fingerprint, and frozen-config design discussion, 2026-08-10  
**Supersedes:** the shared-working-tree portion of ADR 0009 after acceptance  

## Outcome

Give every Git-enabled run its own registered Git worktree from the moment the run is created. A run starts at an immutable base commit without creating or switching to a delivery branch. All agent, command, Git, verification, Graphify, and project-knowledge work for that run executes inside its worktree. The harness creates a human-readable branch only when delivery needs one.

This turns workspace fingerprints into run-local recovery evidence instead of cross-run coordination, keeps the operator's checkout untouched, and makes independent runs safe to advance concurrently.

The project checkout remains the **control root**. It owns configuration defaults and durable harness state. A run worktree is an **execution root**. It owns only that run's repository contents and Git index.

```text
project checkout (control root)
├── agent-harness.config.yaml
└── .agent-harness/
    ├── runs/<runId>/
    │   ├── config.json          frozen, mutable run policy
    │   ├── workspace.json       worktree identity and Git coordinates
    │   ├── state.json
    │   └── events.jsonl
    ├── worktrees/<runId>/       execution root (default placement)
    └── locks/
        └── workspace-admin.lock
```

`stateDirectory` may be absolute or configured elsewhere; no implementation may assume it is physically inside the checkout. Worktree paths must be resolved from the central state root, not from a run's execution root.

## Why this change

The current harness switches one shared checkout to `git.branchPrefix/<runId>` at start. Consequently, unrelated activity can change the observed branch, `HEAD`, index, dirty paths, or fingerprint. The repository lock prevents corruption but serializes whole runs and forces recovery/configuration paths to understand branch switching.

Worktree isolation removes these causes:

- another run cannot change this run's `HEAD`, index, or dirty files;
- the operator can switch branches or edit the main checkout without invalidating a run;
- `changedFiles()` cannot attribute one run's files to another;
- base-branch selection becomes an immutable `baseSha`, not a branch the harness repeatedly revisits;
- planning, indexing, implementation, verification, and recovery always see the same checkout;
- the process-wide UI queue and long-held repository lock are no longer required for normal run advancement.

Worktrees do **not** eliminate all integrity checks. A human or external tool can still edit a run worktree, an agent can crash after a partial write, and the index can change outside the harness. Run-local workspace evidence remains required for those cases.

## Decisions

### 1. Separate control paths from execution paths

Do not repurpose `HarnessConfig.repositoryRoot` to mean both locations. Introduce explicit runtime paths:

```ts
export type HarnessPaths = {
  controlRoot: string;
  stateRoot: string;
  workspaceRoot: string;
};
```

- `controlRoot`: checkout from which the project config and run were opened.
- `stateRoot`: stable location of `.agent-harness` or the configured state directory.
- `workspaceRoot`: the run worktree for run-scoped execution; equals `controlRoot` only for Git-disabled or legacy compatibility mode.

`RunStore`, dashboard run discovery, locks, frozen configs, sessions, packets, and events use `stateRoot`. Git operations, agents, commands, verification evidence, Graphify updates/queries, and project-scoped source traversal use `workspaceRoot`.

The composition root must construct these paths before it constructs `ApplicationContext`. Services must not independently derive the state root from the execution root.

### 2. Start detached; create the delivery branch late

At run start:

1. Resolve the selected local base branch to `baseSha` with `git rev-parse <baseBranch>^{commit}`.
2. Reserve a deterministic path under `<stateRoot>/worktrees/<safeRunId>`.
3. Run `git worktree add --detach <path> <baseSha>`.
4. Persist and validate `workspace.json` before invoking Graphify or an agent.

Detached `HEAD` is intentional. A registered worktree keeps its `HEAD` reachable while the run exists. The harness must never prune or remove an unpublished run worktree implicitly.

Create the delivery branch immediately before the first operation that requires a named ref—normally push/PR publication. Derive it from the confirmed feature title and append a short run identifier for collision safety:

```text
<branchPrefix>/<feature-title-slug>-<shortRunId>
```

If a resumed/legacy run already has a branch, retain it. If the proposed late branch already exists and does not point at the run's `HEAD`, fail with an actionable naming conflict; never reset it. Record `run.branch_created` with the requested slug, final name, and `HEAD` SHA.

Local task commits are valid on detached `HEAD`. Checks that currently require `currentBranch === state.branchName` must instead verify the registered worktree identity and expected `HEAD` lineage. Checkpoint squashing must remain limited to commits owned by the run and must reject a published/upstream-backed history.

### 3. Keep frozen policy in the run directory

Continue using `<runDir>/config.json` as the authoritative run policy snapshot. Project configuration supplies defaults for new runs only. Resume loads the frozen snapshot first; deliberate run-scoped repairs may update it.

Centralize all frozen-config mutation behind one operation, for example:

```ts
updateRunConfig(runId, expectedRevision, patch, audit): Promise<RunConfigUpdate>
```

The operation must:

1. take the per-run lock;
2. load and migrate the current frozen snapshot;
3. validate the patch against the permitted run-policy schema;
4. compute the policy diff and new hash;
5. atomically write the snapshot;
6. persist the matching state hash/revision and audit event through the transition journal;
7. update the in-process context only after durable persistence succeeds.

Budget increases, verification setting changes, TDD changes, and configuration repairs must use this path instead of open-coded `config.json` writes.

Paths and workspace identity are runtime metadata, not policy. `repositoryRoot`, `stateDirectory`, worktree path, `baseSha`, current `HEAD`, and branch name must not participate in `configurationHash`. The current hash already omits `repositoryRoot`, `stateDirectory`, and `knowledge.sharedIndexDirectory`; preserve that rule and add regression tests.

### 4. Store workspace identity separately

Add `<runDir>/workspace.json` with a versioned schema:

```ts
type RunWorkspace = {
  version: 1;
  kind: "git-worktree" | "legacy-shared" | "git-disabled";
  controlRoot: string;
  worktreePath?: string;
  gitCommonDir?: string;
  baseBranch?: string;
  baseSha?: string;
  branchName?: string;
  createdAt: string;
  removedAt?: string;
};
```

Canonicalize paths before storing and compare paths using platform-appropriate semantics. On every mutating resume, verify:

- the path is within the configured worktree parent unless explicitly migrated;
- `git rev-parse --show-toplevel` equals the recorded canonical worktree path;
- `git rev-parse --git-common-dir` matches the recorded repository;
- `git worktree list --porcelain` still registers the worktree;
- `HEAD` descends from `baseSha` unless an audited recovery operation changed the base.

`RunState.branchName` remains a delivery summary for API/UI compatibility. `workspace.json` is the authoritative operational mapping. Avoid duplicating rapidly changing `HEAD` in both files; derive it when needed and record important SHA transitions in events.

### 5. Replace the opaque tree hash with diagnostic workspace evidence

Retain a compact fingerprint for optimistic interference detection, but store enough structure to explain a mismatch:

```ts
type WorkspaceEvidence = {
  headSha: string;
  indexTreeSha: string;
  statusDigest: string;
  changedPaths: string[];
  fingerprint: string;
};
```

- `headSha`: `git rev-parse HEAD`.
- `indexTreeSha`: a non-mutating index identity; do not write a tree merely to fingerprint.
- `statusDigest`: hash of normalized, filtered porcelain including untracked paths.
- `changedPaths`: bounded/sorted diagnostic paths, with an omitted count when necessary.
- `fingerprint`: versioned hash of the fields above.

Fingerprint immediately before handing the worktree to an agent or command and stamp the resulting evidence after the harness has validated that step's reported changes. On resume, mismatch means **external interference in this run's worktree**, not “some repository changed.” Error messages should identify whether `HEAD`, index, or working files diverged.

Do not include branch name, absolute worktree path, config hash, run state files, generated artifacts, or timestamps. Keep the existing phantom/autocrlf handling only if a non-mutating refresh cannot replace it; fingerprint calculation should not normally modify the worktree.

`acceptTree` remains an explicit operator action. It records previous and accepted evidence plus reported paths. It does not weaken subsequent checks globally.

### 6. Narrow locking and allow independent runs

Retain the per-run lock for state/config/workspace mutation. Replace the long-held repository lock with a short **workspace administration lock** around operations that mutate shared Git worktree metadata:

- add/register worktree;
- create or rename a shared branch ref;
- remove/prune worktree;
- any shared-index/Graphify operation proven unsafe concurrently.

Normal `advance`, agent calls, tests, commits, recovery, and run-local fingerprints do not take this lock.

Change `RunJobService` from one process-wide promise chain to per-run chains. It must still reject two active mutations for the same run, while allowing different run IDs to execute concurrently. Cancellation stays out of band.

Do not declare Graphify or a shared knowledge index parallel-safe by assumption. Either make their mutable index run-local, protect only refresh/update with a dedicated short lock, or retain serialization for that subsystem while allowing implementation work to proceed independently.

### 7. Redefine dirty-checkout preflight

A worktree created from `baseSha` does not contain uncommitted changes from the operator's checkout. Therefore a dirty control checkout is no longer a reason to block an ordinary run.

Default behavior:

- start from the committed selected base branch;
- show a non-blocking notice when the control checkout is dirty;
- make clear that those changes are not included.

Replace `branch-then-commit` and `commit-then-branch` with an explicit optional **import uncommitted changes** operation. Do not implement this as a hidden commit on the operator's branch. A safe import must capture staged, unstaged, untracked, deleted, renamed, and binary content, apply it inside the new worktree, report conflicts, and record a manifest/digest. Until that complete behavior exists, omit the import option and require the operator to commit changes they want in the run.

Legacy preflight states must remain readable and recoverable, but new worktree runs must not offer the old commit-order choices.

### 8. Cleanup is explicit and conservative

Add a cleanup command/action separate from cancel:

```text
agent-harness cleanup --run-id <id>
```

Before `git worktree remove`, verify the recorded path, registration, run ID, Git common directory, cleanliness, and publication state. Refuse cleanup when:

- the worktree is dirty;
- commits are not reachable from a retained named ref and the run was not explicitly discarded;
- the run is active or non-terminal;
- path validation fails.

For a completed published run, remove the worktree but retain `workspace.json`, state, events, and the branch. For an explicitly discarded unpublished run, require a separate force/discard confirmation through the CLI/API and audit it. Never use `git worktree prune` as automatic run cleanup.

## Delivery slices

Land slices in order. Keep legacy behavior available behind workspace metadata until existing runs can resume safely.

### Slice 0 — ADR, schemas, and test fixture support

**Files:** new ADR; `domain.ts` or a new workspace schema module; testkit Git/project fixtures.

- Accept the control-root/execution-root terminology and late-branch decision in an ADR.
- Add `RunWorkspaceSchema` and `WorkspaceEvidenceSchema` with compatibility defaults.
- Extend `ProjectFixture` to create, inspect, reopen, and safely remove linked worktrees.
- Add Git-version/platform capability checks with actionable errors.

**Gate:** schema/unit tests and real-Git fixture tests pass on Windows and CI.

### Slice 1 — Path separation without behavior change

**Files:** config loading/composition, `ApplicationContext`, dependencies, store, agents, commands, Graphify, knowledge.

- Introduce `HarnessPaths` and thread it through composition.
- Keep `workspaceRoot === controlRoot` for all runs.
- Make `RunStore` depend explicitly on `stateRoot`.
- Replace direct `config.repositoryRoot` execution uses with `ctx.paths.workspaceRoot`.
- Add architecture tests that fail if run-scoped execution uses the control root.

**Gate:** existing behavior and tests remain unchanged; config hash remains stable.

### Slice 2 — Worktree creation and frozen resume

**Files:** `git.ts` split into repository/workspace responsibilities, lifecycle, config I/O, CLI/UI engine factories.

- Add `WorktreeManager.create`, `inspect`, and `open`.
- Create `workspace.json` during start under the workspace-admin lock.
- Recompose every resume from project config + frozen run config + workspace metadata.
- Start clean Git-enabled runs detached at `baseSha`.
- Ensure Graphify, refresh, reflect, and grill use the worktree.
- If creation fails after registration, reconcile/remove only the exact just-created clean worktree and record the block.

**Gate:** the control checkout branch, `HEAD`, index, and files are byte-for-byte unchanged by run start and advance.

### Slice 3 — Run-local evidence and recovery

**Files:** Git evidence, application context, recovery, planning/execution guards, UI diagnostics.

- Introduce structured `WorkspaceEvidence` and versioned fingerprints.
- Remove branch-switch/restamp guards and branch equality checks.
- Change divergence messages and `acceptTree` audit details.
- Verify crash/restart resumes in the recorded worktree.
- Preserve legacy `treeFingerprint` loading until migration is complete.

**Gate:** edits in the control checkout or another run never block this run; edits inside this run's worktree do block it with useful diagnostics.

### Slice 4 — Late branch creation and publishing

**Files:** message/publishing flow, Git service, domain/UI.

- Add deterministic title slugging and collision-safe suffixing.
- Create the branch at publication from the run's current detached `HEAD`.
- Preserve explicit/legacy branch names.
- Update checkpoint ownership checks to use workspace/base/ref evidence.
- Display worktree, base SHA, and “branch pending” in delivery status.

**Gate:** no local branch is created at run start; push and PR creation operate on the late-created branch and target the frozen base branch.

### Slice 5 — Config mutation transaction

**Files:** frozen-config repair, recovery, execution TDD update, planning verification update, store journal.

- Route every run-config update through one validated operation.
- Add config revision/hash audit fields and crash recovery.
- Remove open-coded mutations of `ctx.config` and `config.json`.
- Confirm runtime paths remain outside the policy hash.

**Gate:** killing the process at each write boundary cannot leave a valid config paired with a stale unexplained state hash.

### Slice 6 — Lock narrowing and concurrency

**Files:** store locks, run advancer, recovery/planning locks, UI job service, knowledge/Graphify coordination.

- Remove repository lock acquisition from normal run operations.
- Add the workspace-admin lock and any dedicated shared-index lock.
- Convert UI scheduling to per-run queues.
- Run two deterministic workflows concurrently in separate worktrees.

**Gate:** two runs may overlap agent and command execution without observing each other's files or blocking on a repository-wide lock.

### Slice 7 — Preflight redesign, cleanup, migration, and docs

**Files:** CLI/UI/API, README, roadmap, ADR 0009 status, migrations, acceptance/E2E tests.

- Remove old preflight commit-order controls for new runs.
- Add dirty-control-checkout notice and document committed-base semantics.
- Add safe cleanup and inspect commands/actions.
- Reopen legacy runs in `legacy-shared` mode; optionally provide an explicit migration that creates a worktree from their existing branch/HEAD only when their tree is clean.
- Document storage, disk use, branch timing, recovery, concurrency, and manual worktree repair.

**Gate:** CLI and dashboard cover start, resume after restart, concurrent advance, publish, cancel, cleanup, dirty control checkout, missing worktree, and legacy run recovery.

## Required tests

### Unit

- run ID/path and title/branch sanitization, including Windows reserved names;
- branch collision handling;
- config hash excludes every runtime path and workspace field;
- workspace metadata migration and path-containment policy;
- structured evidence determinism and versioning;
- per-run job queues overlap different runs but serialize the same run;
- cleanup decision matrix.

### Integration with real Git

- start from a selected base branch while another branch is checked out;
- start while the control checkout is dirty without importing its changes;
- no branch creation at start;
- worktree remains registered and resumable after process reconstruction;
- agents/commands/Graphify receive the worktree as `cwd`;
- commits on detached `HEAD`, checkpoint squash, late branch creation, push to a local bare remote;
- two concurrent runs edit the same relative filename independently;
- operator branch switch and edits do not change either run's evidence;
- external edit, index mutation, and `HEAD` mutation inside a run are detected separately;
- missing/moved worktree produces a recoverable blocked state;
- cleanup refuses dirty/unpublished/non-terminal/path-mismatched targets;
- config-update crash injection at each persistence boundary;
- legacy shared-tree run still loads and follows its old locking rules.

### Acceptance and E2E

- CLI lifecycle from start through publish and cleanup;
- dashboard displays worktree/base/branch-pending state;
- two UI jobs visibly run at the same time;
- cancellation of one run does not stop or queue behind another;
- restarting the UI reattaches to both worktrees;
- branch created from confirmed title with a collision-safe run suffix.

## Migration and compatibility

- Bump `CONFIG_VERSION` only for frozen-config schema/hash changes; version workspace metadata independently.
- Runs without `workspace.json` are `legacy-shared`. They keep repository locking and existing branch/preflight semantics.
- Do not silently create a worktree for a dirty legacy run. Offer migration only after verifying its branch, `HEAD`, index, fingerprint, and clean state.
- `branchName` remains optional and API-compatible. New detached runs show no branch until publication.
- Read the old scalar `treeFingerprint`; stamp structured evidence after the first successful worktree-local checkpoint.
- Keep `unlock --repo` while legacy runs exist. Add lock inspection that distinguishes legacy repository locks from workspace-admin/shared-index locks.

## Observability and audit events

Add at least these events:

- `run.worktree_created`: canonical path, base branch, base SHA, Git common-directory identity;
- `run.worktree_reopened`: validation result after process restart;
- `run.workspace_diverged`: which evidence components changed and bounded paths;
- `run.workspace_accepted`: previous/new evidence and operator-reported paths;
- `run.branch_created`: title slug, final branch name, SHA;
- `run.config_updated`: revision, previous/new hash, changed policy paths, reason;
- `run.worktree_removed`: retained branch/ref and cleanup reason;
- `run.workspace_migrated`: legacy source branch/SHA and new worktree identity.

Never put absolute paths, command output, diffs, or credentials into user-visible events without applying the existing disclosure and size policies. The local `workspace.json` may contain canonical paths needed for recovery.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Worktrees consume substantial disk | Show per-run path/age, make cleanup easy and explicit, document shared object storage vs duplicated build artifacts. |
| Detached commits are lost during cleanup | Registered worktree keeps `HEAD` reachable; refuse removal until commits are published/retained or explicitly discarded. |
| State root is accidentally resolved inside the worktree | Introduce `HarnessPaths`; make `RunStore(stateRoot)` explicit; add architecture and restart tests. |
| Graphify/shared knowledge is not concurrency-safe | Separate run-local indexes or protect only their update sections with a dedicated lock. |
| Windows path length/locking failures | Use short safe run directory names, canonical path validation, bounded retries only for known transient file locks, and Windows CI. |
| Branch title changes after confirmation | Freeze the proposed delivery slug when branch creation is requested; later title edits do not rename a published branch automatically. |
| Main checkout is dirty and user expects changes in the run | Display explicit committed-base semantics; add import only when full-fidelity snapshot behavior is implemented. |
| Config and state hashes diverge after a crash | One run-config mutation service plus transition journaling and recovery tests. |

## Completion criteria

This migration is complete when:

1. every new Git-enabled run has a validated `workspace.json` and registered worktree before any agent/indexing work;
2. the main checkout is never switched or mutated by normal run lifecycle operations;
3. no delivery branch is created before it is needed;
4. all run-scoped execution uses `workspaceRoot`, while all durable run state uses `stateRoot`;
5. different runs can advance concurrently without a repository-wide execution lock;
6. fingerprints report only interference within their run worktree and provide component-level diagnostics;
7. all frozen-config changes are validated, revisioned, hashed, journaled, and audited through one path;
8. dirty-checkout, cleanup, publication, restart, and legacy migration behavior are documented and covered by real-Git integration tests.

## Non-goals

- Parallel execution of multiple frontier tasks inside one run. One run retains one mutable worktree and one run lock.
- Automatic merging or rebasing onto a moving base branch.
- Silently importing the operator's uncommitted changes.
- Automatically deleting abandoned worktrees or unreachable commits.
- Replacing Git branches for publication; worktrees defer branch creation, they do not remove the need for a pushable ref.

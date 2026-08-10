# External harness home and zero-footprint target repositories

**Status:** implemented (slices 0–5)  
**Scope:** `packages/agent-harness`  
**Origin:** external control-plane design discussion, 2026-08-10  
**Depends on:** `docs/plans/per-run-worktrees.md` path separation and workspace metadata  

## Outcome

Move all harness-owned configuration, rules, skills, workflows, state, artifacts, indexes, locks, sessions, and run worktrees outside the target repository. The target repository is an execution target only. New projects do not receive a checked-in manifest or a repository-local `.agent-harness` directory.

The harness discovers a target repository from an explicit path or the current directory, resolves it to an external project registration, and creates every run inside an externally managed Git worktree. Agents receive the worktree as their workspace and do not receive the harness home as a writable root.

```text
target repository (control root)
└── source controlled project files only

harness home (control plane)
├── config.yaml
├── guidance/
│   ├── rules/
│   └── skills/
├── workflows/
├── agents/
├── projects/
│   └── <project-key>/
│       ├── registration.json
│       ├── config.yaml
│       ├── runs/
│       │   └── <run-id>/
│       │       ├── config.json
│       │       ├── workflow.json
│       │       ├── workspace.json
│       │       ├── state.json
│       │       ├── events.jsonl
│       │       ├── artifacts/
│       │       └── sessions/
│       ├── knowledge/
│       └── locks/
└── shared caches and installed components

sibling worktree root (execution data)
└── <repository-name>-worktrees/
    └── <safe-run-id>/
```

The sibling worktree root is intentionally easy for a human to discover while remaining outside the target repository. It contains repository checkouts that agents are expected to modify, not protected harness control-plane data.

## Why this change

Repository-local harness deployment currently mixes project source with tool installation and runtime data. That creates several problems:

- harness files add noise to target repositories and working-tree status;
- generated state, indexes, artifacts, and sessions can consume substantial space;
- agents operating in the repository can accidentally edit harness configuration or guidance;
- cleanup has to distinguish project files from tool-owned files;
- repository clones inherit harness files even when the new machine has different providers, paths, or policies;
- configuration and runtime paths become coupled to one checkout layout.

External storage establishes a clear ownership boundary: the target repository owns source; the harness home owns orchestration and runtime data.

## Worktree placement decision

Git does not define a conventional mandatory directory for linked worktrees. `git worktree add <path> <commit>` requires the caller to choose a path. Developer-managed worktrees are commonly placed beside the primary checkout. Tool-managed worktrees are commonly placed beneath an application-controlled data or cache directory.

For the harness, derive a sibling worktree root from the target repository by default:

```text
<parent>/<repository-name>-worktrees/<safe-run-id>
```

For example:

```text
D:\src\billing-service
D:\src\billing-service-worktrees\run-01
D:\src\billing-service-worktrees\run-02
```

This convention makes active and retained worktrees visible to developers without putting them inside the repository. The harness must still treat the directory as managed storage and validate ownership before creating or removing entries.

Allow `worktreeRoot` to override the derived sibling path independently from the durable state root. This supports:

- a short path such as `D:\\ah-wt` on Windows;
- placement on a volume with sufficient capacity;
- faster local storage for large repositories;
- organizational policies that require workspaces beneath a specific directory;
- repositories whose parent directory is not writable.

Before using the derived sibling directory, validate that:

- its canonical path is outside the target repository;
- it is exactly the expected `<repository-name>-worktrees` path or an explicit configured override;
- an existing directory is either empty or already carries harness ownership metadata matching this registered project;
- no symlink or junction redirects it into the target repository or another project;
- the target path for a run does not already exist unless it is the exact registered worktree being reopened.

### Git metadata caveat

A linked worktree is external in content but not completely independent of the target repository's Git database. Git records small administrative entries under the repository's common Git directory, normally `.git/worktrees/<name>`. This is Git-owned metadata, not harness state, and is required for a registered linked worktree.

Eliminating even that metadata would require a separate clone or bare repository owned by the harness. That would introduce fetch synchronization, object duplication or alternates, remote and credential handling, and base-ref freshness concerns. It is not part of this plan. The harness will use ordinary registered worktrees and limit its changes to Git's required administrative metadata.

## Harness home location

Resolve a platform-appropriate default, with an environment variable and CLI/config override:

- Windows: a non-roaming local application-data directory;
- macOS: the user's Application Support directory;
- Linux: `XDG_STATE_HOME` when set, otherwise the conventional local state directory.

Do not use the process current directory, the target repository, or a relative `stateDirectory` as the default.

Introduce explicit roots rather than overloading one path:

```ts
type HarnessHomePaths = {
  homeRoot: string;
  projectsRoot: string;
  sharedGuidanceRoot: string;
  workflowsRoot: string;
};

type ProjectPaths = {
  controlRoot: string;
  worktreeRoot: string;
  projectStateRoot: string;
  projectKnowledgeRoot: string;
  projectLocksRoot: string;
};
```

The existing run-bound `HarnessPaths` remains responsible for `controlRoot`, `stateRoot`, and `workspaceRoot`. Composition derives it from the external registration and `workspace.json`; services do not independently reconstruct paths.

## Project registration and discovery

Because there is no repository manifest, project identity lives entirely in the harness home.

Add an explicit registration operation:

```text
agent-harness project add --repository <path> [--name <name>]
```

Persist a registration resembling:

```ts
type ProjectRegistration = {
  version: 1;
  projectKey: string;
  displayName: string;
  controlRoot: string;
  canonicalControlRoot: string;
  gitCommonDir?: string;
  remoteFingerprint?: string;
  createdAt: string;
  updatedAt: string;
};
```

Use a generated stable project key for storage. Paths and remote fingerprints are discovery evidence, not the sole project identifier.

Discovery order:

1. an explicit `--project` key;
2. an explicit `--repository` path matched to a registration;
3. the current directory resolved to a registered repository root;
4. otherwise fail with an actionable registration command.

Do not silently create a project registration during an operation that starts or advances a run.

Moved repositories require an explicit `project relink` operation that validates Git identity and audits the old and new paths. Multiple clones may be registered as distinct projects unless the operator explicitly links or aliases them.

## Configuration ownership

Replace repository-local `agent-harness.config.*` discovery with:

```text
<harness-home>/config.yaml
<harness-home>/projects/<project-key>/config.yaml
```

Configuration precedence for a new run is:

```text
built-in defaults
  → harness-home defaults
  → external project configuration
  → explicit CLI overrides
  → frozen run snapshot
```

Once created, the frozen run snapshot remains authoritative according to the existing frozen-configuration design. Runtime paths and registration identity remain outside the policy hash.

Configuration files must not contain provider secrets. Continue resolving credentials from the provider's supported credential store or named environment variables.

## Rules, skills, agents, and workflows

Harness-owned reusable components live under the harness home or the installed package, never in the target repository.

Resolution order is:

1. project-specific external component;
2. user/global external component;
3. built-in packaged component.

Project source files may still be selected as read-only knowledge sources, but they are ordinary repository content rather than deployed harness guidance.

At run creation, freeze the exact effective workflow, agent profiles, prompts, rules, and skills that can influence execution. Store canonical copies or immutable content-addressed artifacts under the run directory and record their hashes. Editing external definitions must not change an existing run on resume.

Do not expose harness-home paths in agent prompts unless a specific read-only artifact has been intentionally copied into the work packet.

## Agent isolation boundary

External placement reduces accidental modification but is not, by itself, a security sandbox. The harness must enforce the boundary through agent and command execution policy.

For agent invocations:

- set the run worktree as the only writable workspace root when the provider supports workspace restrictions;
- do not give the agent a writable mount or tool rooted at the harness home;
- pass configuration and guidance as bounded packet content, not as external filesystem paths;
- verify workspace evidence and changed paths after every mutating invocation;
- reject providers that cannot satisfy a required isolation mode when strict isolation is enabled.

Harness-launched deterministic project commands run with the worktree as `cwd`, but an unrestricted local process may still access other user files. This plan does not claim an operating-system security boundary for arbitrary commands. Strong command isolation requires a later sandbox/container design.

Only the host harness process writes project state, events, frozen definitions, indexes, and registrations.

## Lifecycle and cleanup

Project removal and run cleanup are explicit operations:

```text
agent-harness cleanup --run-id <id>
agent-harness project remove --project <project-key>
```

Run cleanup follows the conservative worktree rules in the per-run worktree plan. Project removal must refuse while registered worktrees, active runs, or unpublished commits remain. Removing a registration must not delete or modify the target repository.

The harness should report storage consumption by category before deletion:

- worktrees;
- run artifacts and sessions;
- knowledge indexes;
- logs and caches.

Caches may have independent retention policies. Durable run state and unpublished worktrees may not be evicted automatically.

## Migration

Existing repository-local installations require an explicit migration command:

```text
agent-harness migrate-home --repository <path>
```

Migration must:

1. detect repository-local configuration, state, guidance, and active runs;
2. refuse to migrate while a run is actively mutating;
3. create and validate the external project registration;
4. copy configuration and harness-owned guidance into the external project area;
5. migrate state and workspace metadata without changing run IDs;
6. validate every registered worktree and rewrite only path metadata that legitimately changed;
7. compare file counts and content hashes;
8. leave the original data untouched until validation succeeds;
9. print the exact repository-local paths that can subsequently be removed;
10. require a separate explicit cleanup action to remove the old files.

Do not automatically delete repository-local data during migration. Do not commit migration changes or modify `.gitignore`.

Legacy runs remain readable through an explicit compatibility path during the migration window. New runs use external storage only after the project registration is activated.

## Delivery slices

Land this after the current worktree path-separation and workspace-metadata foundation is stable. Avoid mixing storage migration into the active worktree creation changes.

### Slice 0 — ADR and path contract

- Accept the zero-footprint and external-worktree decisions in an ADR.
- Define platform home resolution and explicit `HarnessHomePaths` / `ProjectPaths`.
- Specify overrides and canonical path rules.
- Add architecture tests prohibiting runtime storage beneath `controlRoot`.

**Gate:** path-resolution tests cover Windows, macOS, and Linux conventions without writing outside temporary fixtures.

### Slice 1 — External project registry

- Add project registration, lookup, list, relink, and validation services.
- Add CLI commands without changing existing run behavior.
- Detect duplicate roots, moved repositories, missing repositories, and Git identity mismatches.

**Gate:** a registered project can be rediscovered after restart from explicit repository path and current-directory lookup.

### Slice 2 — External configuration and components

- Move project configuration lookup to the external project directory.
- Resolve external rules, skills, workflows, and agent profiles.
- Freeze effective component contents and hashes when creating a run.
- Remove automatic guidance seeding into target repositories for newly registered projects.

**Gate:** changing external configuration or guidance after run creation does not alter a resumed run.

### Slice 3 — External run state and worktrees

- Make the external project state directory the only location for new run state.
- Default new run worktrees beneath the derived sibling `<repository-name>-worktrees` root.
- Keep an explicit project-level `worktreeRoot` override for unsuitable sibling locations.
- Preserve `controlRoot` solely as repository identity/base-ref input.
- Confirm Graphify, knowledge, agents, commands, Git, and verification use the run worktree.

**Gate:** starting and completing a run creates no harness-owned file in the target working tree; only Git's required linked-worktree administrative metadata changes under the common Git directory.

### Slice 4 — Migration and compatibility

- Implement copy-validate migration.
- Support legacy repository-local runs during a bounded compatibility period.
- Add explicit post-migration cleanup with exact-path validation.
- Document rollback before cleanup.

**Gate:** an in-progress legacy run can be migrated, reopened, and completed with the same run ID and frozen policy.

### Slice 5 — Storage operations and isolation enforcement

- Add storage usage reporting and conservative cleanup.
- Add provider workspace-capability validation.
- Add tests proving agent-visible workspace roots exclude harness home.
- Add diagnostics for permissions, unavailable volumes, path length, and insufficient space.

**Gate:** the harness refuses strict-isolation execution through a provider that cannot restrict the writable workspace as required.

## Required tests

### Unit

- platform-specific harness-home defaults and overrides;
- safe project and run path construction;
- project registration schema and canonical-path comparisons;
- configuration precedence and frozen hashes;
- component resolution and content snapshots;
- rejection of traversal, symlink/junction escape, and unsafe cleanup targets;
- architecture test: no new-run state path descends from `controlRoot`.

### Integration with real Git

- create an external worktree and verify its registration;
- confirm target tracked and untracked files are unchanged throughout a run;
- confirm only expected `.git/worktrees` metadata is added;
- resume after restart using only external registration and run metadata;
- move/relink a repository;
- operate two registered repositories with identical directory names;
- handle a missing worktree root or disconnected volume;
- refuse cleanup for dirty or unpublished worktrees.

### Acceptance and E2E

- register → configure → start → advance → publish → cleanup;
- start from inside a registered repository with no local harness files;
- actionable error from an unregistered repository;
- migrate a repository-local installation and resume its run;
- display external storage usage and worktree location;
- verify agent activity cannot modify external harness files through provided workspace tools.

## Completion criteria

- New target repositories receive no harness-owned files or directories.
- No new-run config, state, artifact, session, index, log, lock, rule, skill, agent, or workflow is written beneath the target control root.
- Run worktrees default to `<repository-name>-worktrees/<run-id>` beside the target repository, or an explicit external override.
- Every run freezes its effective orchestration inputs for deterministic resume.
- Agents are scoped to the run worktree through all supported provider workspace controls.
- Existing repository-local runs have an explicit, validated, non-destructive migration path.
- Cleanup never guesses ownership from a path alone.

## Non-goals

- A portable repository manifest.
- Committing harness configuration or guidance to target repositories.
- Replacing linked worktrees with independent clones or bare-repository mirrors.
- Providing a complete OS-level sandbox for arbitrary project commands.
- Redesigning the customizable orchestration graph in the same change.
- Automatically deleting legacy repository-local harness data.

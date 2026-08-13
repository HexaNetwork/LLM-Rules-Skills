# Handoff: Repository-intelligence legacy leftovers

**Date:** 2026-08-13
**Branch:** `main`
**Status:** done

## Summary

The pluggable Repository Intelligence broker (ADR 0014) is committed on `main`. Structural retrieval now goes through `knowledge.repositoryIntelligence` + adapters (GitNexus / CodeGraph), with CLI/UI mostly neutralized. This handoff catalogs **dead or retired surfaces that still linger** after Graphify → CodeGraph → broker — code, tests, and docs that assume removed flags, legacy config keys, or pre-broker application paths.

## Goal

Capture actionable cleanup of leftovers so the next session can delete or migrate them without re-discovering what the broker already replaced.

## Accomplished

- Committed RI broker work: `90afaa0` — *Introduce a pluggable repository-intelligence broker so structural retrieval can swap adapters without CodeGraph-shaped harness APIs.*
- ADR `docs/adr/0014-repository-intelligence-broker.md`, broker package under `packages/agent-harness/src/infrastructure/repository-intelligence/`, retrieval orchestrator, config migrations, CLI/UI neutralization, and related unit/integration/acceptance updates are in that commit.
- Plan todos for the broker work are complete; remaining work is **cleanup of dead leftovers**, not more broker feature work.
- **2026-08-13 leftover cleanup (this session):** retired CLI `--tdd` from acceptance/docs; migrated fixture writes off `knowledge.codegraph`; deleted dead `CodegraphRepositoryLookup` / `INDEX_SOURCE`; fixed operator README/`--no-repository-intelligence`; smoke acceptance green.

## Key decisions

- Live/frozen configs may still *read* `knowledge.codegraph` / `knowledge.graphify` and `workflow.codegraphCharacters` / `graphifyCharacters` via `rewriteGraphifyConfigKeys` — intentional migration compatibility; new writes should only use the neutral shape.
- Provider-specific CodeGraph helpers may remain behind the adapter; application paths should not re-expose CodeGraph-shaped harness APIs.
- **`CodegraphRepositoryLookup` deleted** (not folded into the adapter). Adapters already own prepare/search via `CodeGraphAdapter` + broker; `codegraph.ts` keeps only shared query/excerpt helpers (`buildCodegraphQuery`, `shapeCodegraphQuery`, `packCodegraphExcerpt`, `compactDomainSeed`, stopwords). Packet sources stay `repository:codegraph` from the adapter.
- Older Graphify ADRs/plans not linked from README were left historical; ADR 0014 deploy flag wording aligned to `--no-repository-intelligence`.

## Current state

### Git

- **Branch:** `main` (do not push unless asked)
- **Uncommitted:** leftover cleanup under `packages/agent-harness/` + this handoff + small ADR 0014 wording fix. Leave alone `docs/handoff/2026-08-13-fork-run-checkpoints.md`.
- **Recent commits:**
  - `90afaa0` Introduce a pluggable repository-intelligence broker…
  - `9ab6854` Add a small docs-writer agent…
  - `52503be` Replace Graphify structural retrieval with CodeGraph…

### Code areas touched (broker — done)

| Area | Notes |
|------|-------|
| `src/infrastructure/repository-intelligence/` | Broker + CodeGraph/GitNexus adapters |
| `src/application/retrieval-orchestrator.ts` | Neutral retrieval orchestration |
| `src/config/{schema,migrations,defaults,io}.ts` | Neutral config + legacy key rewrite |
| CLI / UI / packet / knowledge | Provider-neutral wiring |
| ADR 0014 + README + tests | Documented and covered in `90afaa0` |

### Leftover cleanup (this session)

| Area | Change |
|------|--------|
| Acceptance CLI | Dropped `--tdd`; `cli-errors` asserts unknown flag instead of TDD validation |
| README / ADR 0014 | `--no-repository-intelligence`; removed `start --tdd` docs |
| Fixtures/tests | Writes use `repositoryIntelligence: { enabled: false }` |
| `src/codegraph.ts` | Helpers only; dead lookup class / `INDEX_SOURCE` / `runCodegraph` removed |
| Acceptance smoke | Added missing `scenario-planner` / `scenario-writer` stubs (orthogonal to RI; unblocked smoke) |

## Open items

- [x] **Remove retired CLI `--tdd` from acceptance (and docs).** CLI no longer defines `--tdd`, but tests still pass it and assert the old error:
  - `packages/agent-harness/tests/acceptance/cli-lifecycle.test.ts` (multiple `start … --tdd off`)
  - `packages/agent-harness/tests/acceptance/cli-errors.test.ts` (expects `/tdd must be 'on' or 'off'/i`)
  - `packages/agent-harness/README.md` still documents ``start --tdd on|off`` (~L68)
  - Drop flags from tests; fix README; re-run acceptance.

- [x] **Stop writing legacy `knowledge.codegraph` in fixtures/tests** (migration still accepts on read — keep that until a deliberate sunset). Call sites still nesting under `knowledge.codegraph` / reading `fixtureConfig(…).knowledge.codegraph`:
  - `tests/unit/agent-episode.test.ts`
  - `tests/integration/{git,external-harness-home,http-security,stale-lock-recovery,verification-gate,worktree-cleanup}.test.ts`
  - Also check `tests/e2e/helpers.ts` (`codegraph: { enabled: false }` under knowledge)
  - Prefer `knowledge.repositoryIntelligence: { enabled: false }` or `providers.codegraph` under the neutral tree (as `project-fixture.ts` / acceptance helpers already do).
  - Also fixed adjacent leftovers: `restart-resilience`, `lifecycle-scripted`, `per-run-worktrees`.

- [x] **Retire or shrink pre-broker `CodegraphRepositoryLookup` surface.** Deleted the class and related `RepositoryLookup*` / `INDEX_SOURCE` / `runCodegraph` exports. Kept query/excerpt helpers used by adapters. Unit coverage for lookup behavior remains in `codegraph-adapter.test.ts`.

- [x] **Neutralize leftover `codegraph:` audit/source strings where the broker already has provider-neutral vocabulary.** Removed `INDEX_SOURCE = "codegraph:.codegraph"` with the dead class. Adapters already emit `repository:codegraph` / `repository:gitnexus`.

- [x] **Stale docs / plans still Graphify- or CodeGraph-CLI-shaped (historical plans OK to leave; operator docs should not lie):**
  - README `--no-codegraph` → `--no-repository-intelligence`.
  - ADR 0014 consequence line updated to match CLI.
  - Older ADRs/plans not linked from README left as historical.
  - Migration helper name `rewriteGraphifyConfigKeys` unchanged (still documents Graphify/CodeGraph read rewrites).

- [x] **Smoke acceptance after leftovers:** `cli-errors`, `cli-lifecycle`, `external-harness-home-lifecycle` all pass after `--tdd` strip. Acceptance scripts also needed `scenario-planner` / `scenario-writer` stubs (orthogonal; not RI).

## Remaining gaps

- ~~`templates/.../harness-run/SKILL.md` still mentions `--tdd`~~ — cleaned in TDD sunset follow-up.
- ~~Dead `src/graphify.ts` / `graphify-lookup.ts`~~ — already deleted in `52503be` (Graphify → CodeGraph); confirmed absent on disk.
- Migration read-compat for `knowledge.codegraph` / `graphify` intentionally retained (`rewriteGraphifyConfigKeys`).

## Blockers

None.

## Follow-up (done in TDD sunset session)

See `docs/handoff/2026-08-13-tdd-sunset.md` and `docs/plans/agent-harness-legacy-sunset.md`.

## Tests run (leftover cleanup)

**Pass:**
- Unit: `codegraph`, `codegraph-adapter`, `repository-intelligence`, `repository-intelligence-config`, `agent-episode`, `config` (55 tests)
- Integration: `git`, `http-security`, `stale-lock-recovery`, `verification-gate`, `worktree-cleanup`, `external-harness-home` (28 passed, 1 skipped)
- Acceptance: `cli-errors`, `cli-lifecycle`, `external-harness-home-lifecycle` (7 tests)

## Context for next session

1. Read ADR 0014 first: `docs/adr/0014-repository-intelligence-broker.md`.
2. Optional follow-ups: retire Graphify source files; strip `--tdd` from guidance templates as part of TDD sunset; deliberate sunset of `rewriteGraphifyConfigKeys` read-compat.
3. Unrelated untracked: `docs/handoff/2026-08-13-fork-run-checkpoints.md` — leave alone.

## References

- Commit: `90afaa0`
- ADR: `docs/adr/0014-repository-intelligence-broker.md`
- Related sunset plan (orthogonal legacy-shared / TDD step sunset — do not conflate): `docs/plans/agent-harness-legacy-sunset.md`

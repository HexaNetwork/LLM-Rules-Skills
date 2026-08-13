# Handoff: TDD sunset leftovers + Graphify confirmation

**Date:** 2026-08-13
**Branch:** `main`
**Status:** done

## Summary

Finished orphan cleanup after the legacy sunset checklist (S1–S12) and intent-first workflow already removed production TDD loop / `--tdd` surfaces. Confirmed Graphify source modules were already deleted; cleaned remaining docs, skills, and tests that still assumed RED/GREEN / `red-writer` / `tddLoop`.

## Goal

Close the open gaps from `docs/handoff/2026-08-13-ri-legacy-leftovers.md` (Graphify dead code + `--tdd` guidance) and complete TDD sunset leftovers called out by `docs/plans/agent-harness-legacy-sunset.md` / intent-first.

## Accomplished

### Part A (prior commit)

- `8adfc8f` — Retire post-broker RI leftovers (fixtures/CLI docs, dead `CodegraphRepositoryLookup`, `--tdd` stripped from acceptance/README).

### Part B — Graphify

- Confirmed `src/graphify.ts`, `graphify-lookup.ts`, and `tests/unit/graphify.test.ts` were deleted in `52503be`.
- Kept `rewriteGraphifyConfigKeys` migration read-compat (intentional).
- Left `graphify-out` path noise detection in `step-utils.ts` (harmless).

### Part C — TDD sunset leftovers

- Updated `harness-run` skill: no `--tdd`; describe intent-first start freeze.
- Deleted `templates/guidance/General/skills/red-writer-tdd/`.
- README guidance assignments example uses scenario-/unit-test-writer roles (no `red-writer`).
- ADR 0013 marked **Superseded** by intent-first.
- e2e helpers: dropped `#tdd` / `workflow.tdd`.
- Stripped skipped/orphan RED/GREEN tests from `workflow.test.ts`, `git.test.ts`, `ui.test.ts`; rewrote remaining active fixtures off `tddLoop` / `red-writer`.
- Unit/integration fixtures updated (`testkit-scripted-backend`, `knowledge`, `evidence-fingerprint`, `external-harness-home`).
- Architecture paths test no longer requires `codegraph.ts` to consume `workspaceRoot` (helpers-only after RI leftover cleanup).

## Tests run

**Pass:**
- Unit: 67 files / 473 tests
- Integration: 18 files / 110 passed, 1 skipped
- Acceptance: 3 files / 7 tests

## Open items

- Deliberate sunset of `rewriteGraphifyConfigKeys` read-compat (keep until frozen configs age out).
- Unrelated untracked: `docs/handoff/2026-08-13-fork-run-checkpoints.md` — leave alone.

## References

- RI leftovers commit: `8adfc8f`
- Graphify deletion: `52503be`
- Sunset plan: `docs/plans/agent-harness-legacy-sunset.md`
- Intent-first plan: `docs/plans/intent-first-workflow.md`
- ADR 0013 (superseded): `docs/adr/0013-alternating-persistent-tdd-loop.md`

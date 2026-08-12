# Handoff: Scenario testing Gradle filter

**Date:** 2026-08-12
**Branch:** `main`
**Status:** exploratory

## Summary

Investigated Emperor test-harness run `356ffa23-ca3d-4e28-8278-31f87f04acc4`, which blocked in `scenario_testing` on the first of 40 scenarios. The scenario tests themselves pass; the harness ran Gradle `--tests` with a **file path** instead of a class name, classified “No tests found” as a production failure, spent 1.59M tokens on a no-op implementer, then hit `scenario.no_progress`. No harness code was changed this session.

## Goal

Explain why scenario-writer cost ~1.3M tokens, why an implementer ran after the scenario appeared to pass, and why the run died on `Scenario repair_routed` → `Scenario no_progress`.

## Accomplished

- Reconstructed the run from harness home artifacts (events, packets, sessions, frozen config).
- Identified three stacked bugs: path-vs-FQCN filter, mis-classification of “No tests found”, and fingerprint `no_progress` after a no-op repair.
- Confirmed production for `SC-BA-001` is likely fine; the writer’s test file is usable once the harness can actually run it.

## Key decisions

- Treat this as a **harness bug**, not a production-code failure in Emperor.
- Do not resume the Emperor run until `testTargetTemplate` / path→class conversion is fixed; otherwise `SC-BA-001` stays `failed` and the harness will skip to `SC-BA-002`, then die later on the leftover failed scenario.

## Current state

### Git

- **Branch:** `main`
- **Uncommitted:** yes — large unrelated WIP (task-review skill, run-setup, UI/review routing). **Not from this session.**
- **Recent commits:** `92b3aff` Remove task-owned testFilter and hand verification commands to implementers.

### Code areas touched

| Area | Notes |
|------|-------|
| `packages/agent-harness/src/application/scenario-testing-service.ts` | Interpolates `scenario.testPaths[0]` into `commands.testTargetTemplate`. Uses `verification[0]` (spotlessCheck on this run) as timeout fallback. |
| `packages/agent-harness/src/application/evidence-fingerprint.ts` | `failureCategoryFromEvidence` maps non-zero exit to `"verification"`; does not treat “No tests found”. `classifyRunnableRed` already has `no_tests` but scenario testing never calls it. |
| `packages/agent-harness/src/application/planning-service.ts` | Project-profiler prompt says use `{filter}` for targeted tests; does **not** say `{filter}` is a file path. |
| Emperor run (read-only) | `C:\Users\Nirom\AppData\Local\agent-harness\projects\19d8e3ff24ee40b7\runs\356ffa23-ca3d-4e28-8278-31f87f04acc4` |

## Open items

- [ ] Convert Java `*.java` test paths to FQCN (or `*ClassName`) before substituting `{filter}`, **or** stop proposing `gradlew … --tests {filter}` when `{filter}` is a path. Tell the project-profiler that `{filter}` is a recorded test **path**.
- [ ] Do not invoke a model for targeted-run “No tests found” — treat as config/filter failure (`config-fixer` / operator gate), not production.
- [ ] Wire `classifyRunnableRed` / `no_tests` into `ScenarioTestingService.runScenario` so this cannot classify as `"verification"`.
- [ ] Optional: scenario-writer cost — tighter prompt, skip Graphify god-node dumps (BFS depth 2 from `Buildable`/`Resident`/`Structure` returned 7424 nodes), consider `strictIsolation` (implementer grepped `agent-transcripts`).
- [ ] After the filter fix: unstick run `356ffa23-ca3d-4e28-8278-31f87f04acc4` (clear `SC-BA-001` failed/fingerprint/seen edges, or re-run scenario_testing with the existing test file). Do **not** resume as-is.

## Blockers

Emperor run is `phase: blocked`, `blockedKind: no_progress`, `failure: Repeated scenario-runner → implementer edge for unchanged evidence`. Frozen template is `gradlew.bat test --tests {filter}`.

## Context for next session

**Smoking gun** (implementer packet `16ccaa2d-…`):

```
command: gradlew.bat test --tests civcraft/src/main/test/.../BuildableAreaValidationTest.java
stderr: No tests found for given includes: [...BuildableAreaValidationTest.java](--tests filter)
```

Gradle wants:

```
com.avrgaming.civcraft.civilization.town.structure.construction.chunks.BuildableAreaValidationTest
```

**Timeline (events.jsonl 100–102):** `scenario.tests_written` → implementer invoke (no failure event) → `scenario.repair_routed` (summary: tests already pass, `changedFiles: []`) → `scenario.no_progress`. There is **no** `scenario.passed`.

**Token burn:** writer 1.30M / ~108 steps / ~103s; implementer 1.59M / ~77 steps / ~105s; run total 15.3M / 35 invocations. 40 scenarios planned — writers at 1.3M each would be ~50M+.

**Read first:** `scenario-testing-service.ts` (`runScenarioCommand`, `routeToImplementer`, `blockNoProgress`); `evidence-fingerprint.ts` (`failureCategoryFromEvidence`, `classifyRunnableRed`, `evaluateRepairProgress`); frozen `config.json` in the run dir; `docs/plans/intent-first-workflow.md`.

**Worktree:** `D:/Dev/LLM/Emperor-Test-Harness-worktrees/356ffa23-ca3d-4e28-8278-31f87f04acc4`

## References

- Run state: `C:\Users\Nirom\AppData\Local\agent-harness\projects\19d8e3ff24ee40b7\runs\356ffa23-ca3d-4e28-8278-31f87f04acc4\state.json`
- Writer session: `sessions/0d5fd9c7-8a9b-46d8-baf7-e5251abbec65.json`
- Implementer session: `sessions/170c2b29-eda0-4791-97a9-79c488b1260c.json`
- Intent-first plan: `docs/plans/intent-first-workflow.md`

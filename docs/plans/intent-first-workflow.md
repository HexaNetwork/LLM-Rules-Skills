# Intent-first workflow

**Status:** implemented product behavior; preserved by [ADR 0018](../adr/0018-fresh-modular-harness.md)
**Scope:** `packages/agent-harness`  
**Supersedes:** the removed RED-first per-task TDD design

> The implementation details and phase names below describe the pre-rewrite
> harness. ADR 0018 keeps the intent-first product sequence while replacing its
> runtime with real phase plugins, live settings, and one container per run.

## Intent

Replace RED-first per-task TDD with an intent-first pipeline:

1. Plan + PRD + **scenario-planner** intent scenarios
2. One operator gate for plan + PRD + scenarios
3. Issue slicer tags tasks with `scenarioIds`
4. Implementers build production code (no tests during `executing`)
5. Run-level **scenario_testing** → **crystallizing** (optional coverage) → **final_review** → publish

Per-task review remains during `executing` (intent-conformance). Holistic review runs after coverage. Repair loops reuse evidence-fingerprint / `no_progress` / `seenRepairEdges` guards.

## Slice status

| Slice | Content | Status |
| --- | --- | --- |
| 1 | Delete TDD machinery; implement-first task loop | done |
| 2 | Scenario schema, scenario-planner, bundled gate, slicer tagging | done |
| 3 | `scenario_testing` phase + scenario-writer | done |
| 4 | `crystallizing` + coverage config/parser/gate | done |
| 5 | `final_review` routing + UI/CLI/docs polish | done |

## Phases after executing

```text
executing → scenario_testing → crystallizing → final_review → publishing
```

- **scenario_testing:** scenario-writer implements intent as tests; harness runs them; production failures → implementer; corroborated test defects → scenario-writer; identical evidence → `blocked` / `no_progress`.
- **crystallizing:** when `workflow.coverage.enabled`, run `commands.coverage`, parse lcov/cobertura/clover, optionally invoke unit-test-writer until threshold or no-progress. When disabled, skip to final review.
- **final_review:** holistic reviewer over `baseSha..HEAD`. Routes: `production` → re-enter executing; `scenario-intent` → scenario_testing; `test-design` / `test-coverage` → crystallizing; approved → publishing.

## Configuration note

Coverage remains an optional live project setting in the fresh harness.
Pre-rewrite runs and frozen configuration versions are unsupported.

# Intent-first workflow

**Status:** implemented (slices 1–5 on `redesign/intent-first-workflow`)  
**Scope:** `packages/agent-harness`  
**Supersedes:** [agent-activity-and-self-recovering-tdd.md](./agent-activity-and-self-recovering-tdd.md) (RED-first TDD loop)

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

## Config notes

- `CONFIG_VERSION` 14 introduces `workflow.coverage`, `workflow.maxFinalReviewAttempts`, and optional `commands.coverage`.
- Historical runs with TDD steps remain readable; they cannot be resumed.
- Pre-redesign TDD plan docs remain for history and are marked superseded.

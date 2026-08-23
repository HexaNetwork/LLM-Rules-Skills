# ADR 0020: Role guidance is the sole harness worker instruction source

## Status

Accepted; supersedes [ADR 0006](0006-role-aware-guidance-retrieval.md)

## Context

The fresh modular harness introduced editable, layered `GUIDANCE.md` files for
each worker role. Worker invocation uses that service directly, but the rewrite
left behind the older rule/skill assignment schema, knowledge plugin, packaged
copy of `General/`, and tests for a compiler that no live path called. Those
dead declarations made it appear that workers received skills and allowed the
skill text and role guidance to describe conflicting behavior.

## Decision

- Build every worker instruction context from its role rules, output contract,
  and effective per-role `GUIDANCE.md` only.
- Resolve guidance in project, harness-home, then packaged-default order.
- Keep `budgets.guidanceTokens` as the size limit for the compiled role context.
- Remove rule/skill assignments from project settings.
- Remove the unused knowledge service, assignment compiler, phase injection,
  packaged `General/` copy, synchronization script, and their tests.
- Keep repository intelligence and work-packet retrieval separate from worker
  instructions.

## Consequences

- The dashboard's Agent contexts editor is the single operator-facing place to
  inspect and override worker behavior.
- Updating a general Codex skill cannot silently change a harness worker.
- Existing settings files containing legacy `guidance` assignments remain
  readable because unknown settings keys are ignored, but the values have no
  effect.
- Harness packages contain only role guidance under `templates/guidance/roles`.

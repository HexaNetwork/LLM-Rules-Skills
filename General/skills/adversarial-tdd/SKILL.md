---
name: adversarial-tdd
description: >-
  Spawns two coordinated agents per round—a breaker writing adversarial tests and
  an implementer making them pass—both scoped to one feature. Use when the user
  asks for adversarial TDD, red-team tests, two agents (tests vs implementation),
  or /adversarial-tdd.
disable-model-invocation: true
---

# Adversarial TDD (`/adversarial-tdd`)

Two subagents work the **same feature** with opposing goals:

| Role | Goal | Writes |
|------|------|--------|
| **Breaker** | Find real failures through public behavior | Tests only (RED) |
| **Implementer** | Survive breaker tests with correct, minimal code | Production code (GREEN) |

The **parent agent orchestrates**: locks scope, launches fresh subagents each round, runs tests/build between rounds, and does not write tests or implementation during active rounds unless fixing orchestration failures.

## When to use

- Building or fixing a **bounded** feature (issue, PRD slice, acceptance criteria).
- User wants **stress** on edge cases, misuse, and failure modes—not horizontal “all tests then all code.”
- Complements `tdd` (test quality) and `implement` / `implement-auto` (issue pipeline); use this skill when **adversarial** dual agents are explicitly requested.

## Inputs (required before round 1)

Collect and restate in chat:

1. **Feature** — tracker issue, PRD slice, or user description.
2. **Acceptance criteria** — observable behaviors that define “done.”
3. **Scope** — allowed paths/features; out-of-scope areas breaker must not touch.
4. **Public surface** — hooks, components, services, routes the tests may call (no private-method testing).
5. **Commands** — test command(s) and `npm run build` for this repo.

If scope is unclear, ask once, then proceed with the narrowest interpretation.

## Progress tracker

Maintain in chat:

```markdown
Adversarial TDD (feature: ___):
- [ ] 0. Scope locked: criteria + public surface + paths
- [ ] Round N — Breaker: test(s) added, RED confirmed
- [ ] Round N — Implementer: GREEN confirmed
- [ ] Final: build passed, criteria checklist, breaker satisfied or max rounds
```

## Core rules (both agents)

1. **Same feature** — every test and change must trace to the locked acceptance criteria.
2. **Public behavior only** — follow `tdd`: integration-style tests through the agreed surface; see [tests.md](../tdd/tests.md) and [mocking.md](../tdd/mocking.md).
3. **Vertical rounds** — one round = breaker RED → implementer GREEN. No “write all tests, then all implementation.”
4. **Fresh subagents** — new Task per role per round; do not resume prior breaker/implementer agents.
5. **No scope creep** — no unrelated refactors, catalog churn, or tracker updates unless the user asked.
6. **Fair adversarial** — breaker hunts **legitimate** bugs (boundaries, errors, empty states, invalid input, race/timing only when the feature demands it). Forbidden: flaky timing, env-specific hacks, asserting private fields, or tests that only pass after weakening assertions.
7. **Implementer integrity** — fix production code; do not delete/skip/weaken breaker tests to go green.

## Workflow

### 0. Lock scope

Summarize criteria, public surface, and in-scope paths. Get user approval if they asked for a plan-first run.

### 1. Breaker round (RED)

Launch a **new** subagent (`subagent_type`: `generalPurpose` unless exploration-only recon is needed first with `explore`).

**Breaker prompt must include:**

- Feature summary and acceptance criteria.
- Public surface and in-scope paths.
- Instruction: add **one focused test** (or one describe block with ≤3 tightly related cases, e.g. null/empty/whitespace) that **should fail** on current code.
- Adversarial mindset: “How would a user or caller break this?” — invalid args, boundary values, error propagation, double-submit, stale state, permission gaps, parse failures, i18n keys, accessibility regressions **when** they affect observable behavior.
- Constraints: public API only; no implementation-detail assertions; no flaky tests; run the test command and report failure output.
- Return: files changed, test names, why this case matters, expected failure message.

**Parent after breaker:**

1. `git diff` — only test (and test support) files unless breaker documented a tiny shared fixture in scope.
2. Run targeted tests — **must be RED** (or already green if fixing a regression slice; then breaker must add a stricter case).
3. If RED is not achieved, send breaker one fix-up (same round) or relaunch breaker with the failure output.

### 2. Implementer round (GREEN)

Launch a **new** subagent after RED is confirmed.

**Implementer prompt must include:**

- Same feature scope and criteria.
- Breaker’s test file(s), names, and failure output.
- Instruction: **minimal** production change to pass tests; no broad refactors; no test edits except imports/setup required by new code.
- Run the same tests + `npm run build`; report results and risks.

**Parent after implementer:**

1. `git diff` — production (and allowed) files only; flag if tests were weakened.
2. Run tests — **must be GREEN**.
3. Run `npm run build` per `task-complete-build`.
4. If still RED, one implementer fix-up or relaunch with output; do not start the next breaker round until GREEN.

### 3. Repeat

Increment round number. Breaker may:

- Attack the **next** acceptance criterion, or
- Deepen the **same** criterion with a harder legitimate case.

Stop when **any** of:

- All acceptance criteria have at least one passing adversarial test and breaker reports **no further legitimate failures** in scope.
- **Max rounds** reached (default **8** unless user sets another cap).
- User says stop.
- Preflight/blocker: missing API contract, failing build unrelated to feature—escalate to user.

Optional final **breaker-only** pass: breaker tries regression tests only (no new files if satisfied); if RED, one more implementer round.

### 4. Refactor (parent or single agent)

After criteria are green, parent may refactor with all tests green—never refactor while RED. Re-run tests and build after refactors.

### 5. Commit

Only commit when the user asked. One commit per completed feature slice is typical; follow repository commit style.

## Subagent prompt templates

### Breaker

```text
Role: Adversarial test author (RED only).

Feature: [summary]
Acceptance criteria: [bullets]
Public surface: [hooks/components/services/routes]
In-scope paths: [paths]
Out of scope: [paths]

Add ONE focused failing test (or ≤3 related cases in one block) through the public surface only.
Attack legitimate failure modes: boundaries, invalid input, errors, empty states, misuse.
Do NOT test private methods, mock internals, or add flaky tests.

Run: [test command]
Return: changed files, test names, failure output, which criterion this covers.
```

### Implementer

```text
Role: Implementer (GREEN only).

Feature: [summary]
Acceptance criteria: [bullets]
In-scope paths: [paths]

Failing tests from breaker:
- Files: [...]
- Names: [...]
- Output: [...]

Make minimal production changes to pass. Do not weaken or delete breaker tests.
Run: [test command] and npm run build
Return: changed files, test results, build result, remaining risks.
```

## Gates

| Gate | Action |
|------|--------|
| Breaker changes production code | Reject round; breaker retries tests-only |
| Implementer edits tests to weaken | Reject; implementer retries |
| Diff outside scope | Revert or narrow; relaunch |
| Build fails after GREEN | Implementer fix-up before next round |
| Breaker stuck (no new legitimate cases) | Mark satisfied; proceed to refactor/close |

## Output (end of run)

Report briefly:

- Rounds completed and criteria coverage map (criterion → test file/name).
- Remaining risks breaker called out.
- Tests and build commands run.
- Suggested commit message if user will commit.

## Skill index

- `tdd` — test philosophy, vertical slices, refactor discipline.
- `implement` / `implement-auto` — full issue pipeline when not using adversarial mode.
- `frontend-preflight` — before UI/API features needing backend OpenAPI.
- `diagnose` — if RED/GREEN loops fail for environmental or flaky reasons.

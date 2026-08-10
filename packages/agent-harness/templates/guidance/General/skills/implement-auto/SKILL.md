---
name: implement-auto
description: >-
  Automated implementation entrypoint. Prefer the Agent Harness CLI for
  contract-deterministic AFK runs (prepare/approve/execute/resume). Falls back
  to a prose per-issue loop only when the harness is unavailable or the user
  explicitly requests the legacy chat orchestrator. Use when the user says
  /implement-auto, implement-auto, or asks to automatically implement issues
  from a PRD, issue folder, or tracker.
disable-model-invocation: true
---

# Implement Auto (`/implement-auto`)

## Preferred path — Agent Harness

For AFK implementation queues, **do not re-implement the orchestration loop in chat**. Delegate to the executable harness:

1. Ensure the target repo has `agent-harness.config.yaml` (`npx agent-harness init` if missing).
2. `npx agent-harness prepare --local <bundle>` or `--github <issue>`.
3. Fix any prepare validation errors with the user; do not invent product acceptance criteria.
4. `npx agent-harness approve --draft <draft.json>`.
5. `npx agent-harness execute --manifest <manifest.json>` (or `resume --run-id`).
6. Report the harness final status, branch, PR URL, and blocked reasons.

See `General/skills/harness-run/SKILL.md` and `packages/agent-harness/README.md`.

Use the legacy prose loop below only when:

- the user explicitly asks for the chat orchestrator, or
- Agent Harness is not installed / cannot run in this environment.

## Legacy prose loop (fallback)

Runs a chat-driven per-issue loop:

1. Resolve the PRD and issue list.
2. For each selected issue, launch a **new implementation agent**.
3. Verify, test, and **commit** that issue's completed changes.
4. Launch a **code-review agent** on the issue commit (Standards + Spec).
5. Fix review findings.
6. Move to the next issue.
7. After all issues: run a **YAGNI review agent** on the full branch diff.
8. Fix YAGNI findings and re-run YAGNI until clean or deferred.

Invocation of `/implement-auto` grants permission to create one commit per completed issue unless the user says dry-run, no-commit, or review-only.

## Inputs

Accept either local artifacts or tracker artifacts.

**Issue tracker (canonical)**

- Parent issue, PRD issue, or child issue references.
- Use `github-mcp` to read issue bodies, comments, and sub-issues. If only a parent is provided, gather child issues and order them by dependency/blocker fields.
- Do not use `gh` unless the user explicitly approves a fallback.

## Required Progress Tracker

Maintain this checklist in chat and update it after each issue:

```markdown
Implement-auto progress (source: ___):
- [ ] 0. Source resolved: PRD + issue queue
- [ ] 0b. Tracker: `needs-triage` removed and issue assigned to you (PRD/parent and current issue when applicable)
- [ ] 1. Preflight checked or documented as FE-only
- [ ] 2. Current issue: #/file ___
- [ ] 3. Fresh implementation agent completed current issue
- [ ] 4. Tests/lints/build passed
- [ ] 5. Commit created for current issue
- [ ] 6. Code-review passed (Standards + Spec)
- [ ] 7. Review fixes or explicitly deferred
```

After **all** issues in the queue are done, maintain this run-completion checklist:

```markdown
Implement-auto run complete:
- [ ] 8. YAGNI review completed (three passes vs base branch)
- [ ] 9. YAGNI findings fixed (or explicitly deferred)
- [ ] 10. YAGNI re-run passed after fixes
```

## Workflow

### 0. Resolve Source

Gather the PRD, issue list, dependencies, acceptance criteria, and any manual QA notes.

- Local issue files are durable source material; do not publish tracker issues unless the user asks.
- Tracker issues are source material; use local PRDs only as supporting context unless the tracker issue points to them.
- If both local and tracker sources are present, prefer the issue-specific acceptance criteria from the tracker and use local docs for extra context.

**Tracker triage (`needs-triage`)** — For tracker-backed runs (not local-only files), clear `needs-triage` and **assign the issue to you** as soon as an issue is actively picked up. Skip tracker updates when the user says `dry-run`, `review-only`, or `no-tracker-updates`.

1. Once per run (before the first triage update), call `get_me` and use the returned `login` as the assignee username.
2. After reading the PRD or parent issue, if it has `needs-triage`, triage it (remove label + assign) before preflight or queueing children.
3. At the start of each per-issue loop (§2), before launching the implementation agent, triage the **current** child issue if it still has `needs-triage`.
4. When the entry point is a single child issue (no parent pass), triage that issue only.

Use GitHub MCP per `github-mcp`:

- `issue_read` with `method`: `get_labels` on the issue.
- `issue_write` with `method`: `update`, `issue_number`, `labels` set to all current label names **except** `needs-triage` (the `labels` field replaces the full set—do not drop unrelated labels), and `assignees` set to `[login]` from `get_me` (replaces assignees—intended when picking up work).

### 1. Preflight

Follow `implement` Stage 0:

- B+E work: backend issue is closed and the published OpenAPI contains the needed operations.
- FE-only work: document `**Backend:** None (FE-only)` and proceed.
- Read `docs/DESIGN.md` before UI, routing, app shell, feature boundary, or global styling/token changes.
- For UI changes, search `UI_CATALOG_ENTRIES` in `src/features/dev/uiCatalog/index.ts` before introducing or changing shared UI patterns; extend `uiCatalog/sections/*` and `uiCatalog/demos/*` when adding reusable patterns.

### 2. Per-Issue Implementation Agent

For each issue, triage the current tracker issue if still needed (remove `needs-triage` and assign to you — see **Tracker triage** in §0), then start a **new** subagent. Do not resume a previous implementation agent.

Use a prompt with:

- PRD path or tracker parent.
- The exact current issue body and acceptance criteria.
- Relevant dependency status.
- Repo rules: TDD, `npm run build`, no unrelated changes, no committing from inside the subagent unless explicitly requested.
- Legacy/fallback: when touching files, ratchet per `no-legacy-fallback-code` — one path per contract, remove safe dead branches in touched files, no new compat shims unless a tracker issue + inline pointer.
- A request to return changed files, tests run, build result, legacy cleanup done or deferred, and any unresolved risks.

The implementation agent should use `tdd`: one behavior at a time, green before refactor, tests through public interfaces. It must run targeted tests as appropriate and `npm run build` after code is complete.

### 3. Parent Verification And Commit

After the implementation agent returns:

1. Inspect `git status` and `git diff`.
2. Verify the diff is scoped to the current issue.
3. Run or confirm relevant tests and `npm run build`.
4. Create exactly one commit for the current issue using the repository's commit style.

Do not continue to the next issue while the working tree contains uncommitted changes from the current issue.

### 4. Automated Commit Review

After the issue commit, launch **one new readonly subagent** that follows the `code-review` skill. Do not resume prior review agents — each issue commit gets a fresh review.

The subagent must read and follow `code-review/SKILL.md`, then:

1. **Fixed point:** `HEAD~1` (review only the issue commit).
2. **Spec source:** the current issue body and acceptance criteria (tracker issue fetched via `github-mcp`, or local issue file path).
3. **Standards:** discover from the repository's selected rules and documented conventions (for example `AGENTS.md`, rule files, or `docs/DESIGN.md`) plus the Fowler smell baseline.
4. **Return:** aggregated `## Standards` and `## Spec` reports with the one-line summary.

```text
Follow the code-review skill on the commit just created.
- Fixed point: HEAD~1
- Spec: <current issue body and acceptance criteria>
- Readonly: do not modify files; report findings only.
```

A finding on **either** axis is actionable. Collect the result before deciding whether to enter the fix loop (§5).

### 5. Review Fix Loop

If the code-review finds actionable issues on either axis:

Start a **new agent** to:
1. Fix only issues identified for the current commit;
2. Run the affected tests and `npm run build`.
3. Create a follow-up commit named as a fix/review commit, or amend only if all git safety requirements allow it and the user explicitly requested amend behavior.
4. Launch a **new** readonly subagent following `code-review` on the new `HEAD` (same parameters as §4). Do not resume prior review agents.

Do not start the next issue until **both** Standards and Spec pass or the user explicitly defers a finding.

### 6. Final YAGNI review

After **every** issue in the queue has passed §5 (or the user stopped the run early with at least one issue committed), launch **one readonly agent** that follows the `yagni` skill on the **full branch diff**.

The agent must read and follow `yagni/SKILL.md`, then:

1. **Scope:** all changes on the current branch vs the repository default branch (merge-base diff per the skill).
2. **Passes:** three sequential readonly sub-agents — YAGNI/KISS, complexity depth, class explosion.
3. **Return:** the synthesized final report with **Top actions**.

```text
Follow the yagni skill on the full implement-auto branch.
- Base branch: <repository default, e.g. main>
- Scope: entire branch delta from this run (all issue commits)
- Readonly: synthesize the final report with Top actions; do not fix.
```

If YAGNI reports no actionable findings, the run is complete.

### 7. YAGNI fix loop

If YAGNI reports actionable findings (Critical or Suggestion severity):

Start a **new agent** to:
1. Fix findings from the YAGNI **Top actions** and findings tables — prioritize Critical, then Suggestion; Nice-to-have only when trivial in scope.
2. Run affected tests and `npm run build`.
3. Create a follow-up commit named as a YAGNI simplification/fix commit.
4. Launch a **new** readonly agent following `yagni` on the branch (same parameters as §6). Do not resume prior YAGNI agents.

Do not mark the run complete until YAGNI passes with no Critical or Suggestion findings, or the user explicitly defers specific items.

## Gates

- Stop if preflight fails.
- Stop if an issue is blocked by an incomplete dependency.
- Stop if the implementation agent reports unresolved acceptance criteria.
- Stop if tests or `npm run build` fail and cannot be fixed in scope.
- Stop if code-review finds a critical issue on either axis that cannot be resolved without changing scope.
- Stop if YAGNI finds Critical issues that cannot be resolved without changing scope.

## Output Per Issue

Report briefly:

- Issue implemented.
- Commit hash and message.
- Tests/build run.
- Code-review results: Standards and Spec (pass or findings per axis).
- Any deferred risks approved by the user (including deferred legacy removal with blocker noted).

## Output (run complete)

After YAGNI passes (or deferred items are noted), report briefly:

- Issues implemented (count and list).
- Branch name and base ref used for YAGNI.
- YAGNI verdict and fixes applied (commits).
- Any YAGNI findings explicitly deferred by the user.

## Skill Index

- `agent-harness` for the preferred executable AFK orchestration CLI.
- `implement` for the underlying FE pipeline and gates.
- `tdd` for issue implementation.
- `code-review` for automated commit review (Standards + Spec).
- `github-mcp` for tracker issues and PRs.
- `yagni` for final over-engineering review after all issues.
- `prd-to-issues` only if the user asks to create or revise issue breakdowns.

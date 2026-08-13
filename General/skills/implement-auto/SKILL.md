---
name: implement-auto
description: >-
  Automated implementation entrypoint. Prefer the Agent Harness CLI for
  contract-deterministic AFK runs (start/continue/answer via harness-run).
  Falls back to a prose per-issue loop only when the harness is unavailable
  or the user explicitly requests the legacy chat orchestrator. Use when the
  user says /implement-auto, implement-auto, or asks to automatically implement
  issues from a PRD, issue folder, or tracker.
disable-model-invocation: true
---

# Implement Auto (`/implement-auto`)

## Preferred path — Agent Harness

For AFK implementation queues, **do not re-implement the orchestration loop in chat**. Follow `harness-run`: project registration / external home (if needed) → `start` → operator confirms via the dashboard or `answer` / confirm verbs → `continue` to advance. Report harness final status, branch, PR URL, and blocked reasons.

Use the legacy prose loop below only when the user explicitly asks for the chat orchestrator, or Agent Harness is not installed / cannot run here.

## Legacy prose loop (fallback)

Per issue: fresh implementation agent → verify/test/`npm run build` → one commit → `code-review` (Standards + Spec) → fix loop → next issue. After the queue: `yagni` on the full branch diff → fix until clean or deferred.

Invocation grants permission to create one commit per completed issue unless the user says dry-run, no-commit, or review-only.

## Inputs

Accept local artifacts or tracker artifacts. For tracker work, use `github-mcp` (not `gh` unless the user approves a fallback). If only a parent is provided, gather children and order by dependency/blocker fields.

## Required Progress Tracker

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

After **all** issues:

```markdown
Implement-auto run complete:
- [ ] 8. YAGNI review completed (three passes vs base branch)
- [ ] 9. YAGNI findings fixed (or explicitly deferred)
- [ ] 10. YAGNI re-run passed after fixes
```

## Workflow

### 0. Resolve Source

Gather the PRD, issue list, dependencies, acceptance criteria, and manual QA notes. Prefer tracker issue acceptance criteria when both local and tracker sources exist.

**Tracker triage (`needs-triage`)** — For tracker-backed runs (skip when `dry-run` / `review-only` / `no-tracker-updates`):

1. Once per run, `get_me` → use `login` as assignee.
2. Triage PRD/parent if it has `needs-triage` before preflight.
3. At each per-issue start, triage the current child if needed.
4. Single-child entry: triage that issue only.

Per `github-mcp`: `issue_read` (`get_labels`), then `issue_write` (`update`) with all labels except `needs-triage` and `assignees: [login]`.

### 1. Preflight

Follow `implement` Stage 0 (B+E closed + OpenAPI, or document FE-only). Read `docs/DESIGN.md` before shell/routing/token changes. For UI, search `UI_CATALOG_ENTRIES` before new shared patterns.

### 2. Per-Issue Implementation Agent

Triage if needed, then start a **new** subagent (do not resume). Prompt with: PRD/parent, exact issue body + AC, dependency status, TDD + `npm run build`, no unrelated changes, no commit inside the subagent, ratchet per `no-legacy-fallback-code`. Ask for changed files, tests, build, legacy cleanup, risks.

Implementation uses `tdd`: one behavior at a time, green before refactor, public interfaces only.

### 3. Parent Verification And Commit

Inspect `git status`/`git diff`, confirm scope, confirm tests + build, create exactly one commit. Do not start the next issue with a dirty tree from this issue.

### 4. Automated Commit Review

Launch **one new readonly** subagent following `code-review`: fixed point `HEAD~1`, spec = current issue AC, standards from repo rules/`AGENTS.md`/`docs/DESIGN.md` + Fowler smells. Finding on either axis is actionable.

### 5. Review Fix Loop

On actionable findings: new agent fixes only those, tests + build, follow-up commit (amend only if git safety + user asked), then **new** `code-review` on `HEAD`. Next issue only when both axes pass or user defers.

### 6–7. Final YAGNI review and fix loop

After the queue (or early stop with ≥1 commit): **one readonly** agent following `yagni` on the full branch vs default base. On Critical/Suggestion findings: new agent fixes Top actions, commit, re-run `yagni` until clean or user defers.

## Gates

Stop on: preflight failure; blocked dependency; unresolved AC; unfixable test/build failure; critical code-review or YAGNI finding that needs scope change.

## Output

**Per issue:** issue id, commit, tests/build, Standards/Spec result, deferred risks.

**Run complete:** issue list, branch/base for YAGNI, YAGNI verdict + fix commits, deferred YAGNI items.

## Skill Index

- `harness-run` / `agent-harness` — preferred AFK path
- `implement` — FE pipeline and gates
- `tdd` — issue implementation
- `code-review` — commit review (Standards + Spec)
- `github-mcp` — tracker issues/PRs
- `yagni` — final over-engineering review
- `prd-to-issues` — only if user asks to create/revise breakdowns

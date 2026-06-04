---
name: implement-auto
description: >-
  Automated frontend implementation pipeline built on implement: accepts local PRD/issues or tracker issues, runs one fresh agent per issue, commits after each issue, and performs three automated commit reviews (regular, duplication, legacy/fallback). Use when the user says /implement-auto, implement-auto, or asks to automatically implement issues from a PRD, issue folder, or tracker.
disable-model-invocation: true
---

# Implement Auto (`/implement-auto`)

Runs the `implement` workflow with an automated per-issue loop:

1. Resolve the PRD and issue list.
2. For each selected issue, launch a **new implementation agent**.
3. Verify, test, and **commit** that issue's completed changes.
4. Launch **three readonly review agents** on `HEAD` (regular, duplication, legacy/fallback).
5. Fix review findings.
6. Move to the next issue.

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
- [ ] 6. All three automated reviews passed (regular + duplication + legacy/fallback)
- [ ] 7. Review fixes or explicitly deferred
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

After the issue commit, launch **three new readonly review subagents** on `HEAD` in parallel. Do not resume prior review agents — each issue commit gets a fresh trio.

Each agent gets a **distinct, focused prompt** (below). Do not combine concerns into one mega-prompt.

**Regular review** — correctness, bugs, regressions, missing tests, maintainability. Not duplication or legacy/fallback.

```text
Review the HEAD commit for correctness: bugs, logic errors, regressions, missing
tests, and maintainability risks.

Do NOT investigate duplication, legacy compatibility shims, or fallback code
paths — separate agents cover those.

Inspect `git show --stat HEAD` and `git show HEAD`.

Report only actionable findings with file references and evidence.
```

**Duplication review** — duplicated code, patterns, UI catalog overlap, hooks/helpers/API mappers.

```text
Review the HEAD commit specifically for duplication and unnecessary new
abstractions.

Actively search for new code that duplicates existing code or established
UI/API patterns. Compare against UI_CATALOG_ENTRIES / section demos, similar
components, hooks, helpers, API mappers, styles, tests, fixtures, and domain
logic elsewhere in the repo before concluding there is no duplication.

Inspect `git show --stat HEAD` and `git show HEAD`, and search the codebase
for similar names, behavior, copy, selectors, hooks, helpers, tests, and
styles. Check shared utilities, feature-local utilities, API edge mappers,
kitchen-sink UI examples, and test helpers.

Do NOT review correctness bugs or legacy/fallback shims — separate agents
cover those.

Report only actionable findings with file references and evidence of what
should be reused or consolidated.
```

**Legacy/fallback review** — compat shims, dual paths, old-shape fallbacks, deprecated aliases, expired feature flags. Follow `.cursor/rules/no-legacy-fallback-code.mdc` and `docs/DESIGN.md` → **No legacy fallback code**. The review is a **ratchet**: any file touched in the diff should not leave behind superseded dual paths, shims, or dead branches when removal is safe in scope.

```text
Review the HEAD commit for legacy/fallback and compat-layer code that should
be removed, per `.cursor/rules/no-legacy-fallback-code.mdc` and
`docs/DESIGN.md` → No legacy fallback code.

In changed files (and same-feature folders when obvious), flag code that only
exists for a superseded contract:
- Dual code paths after migration is done
- Compatibility shims mapping old prop/field/route names to new ones
- Old-shape fallbacks (e.g. newField ?? oldField, legacy_id || id)
- Deprecated aliases or re-exports alongside new exports
- Dead/commented branches, if (false), TODO-stubs kept "just in case"
- Feature-flag dual paths where rollout is complete (flag + dead branch should go)

Distinguish allowed runtime behavior (error/retry UI, empty states, optional
live API fields, DEV gates, active rollout flags) from forbidden compat
layers. Prefer deleting the old path over adding another branch. Time-bound
exceptions require a tracker issue link and inline
`// compat: remove when #NNNN closes`.

Grep callers within the same `features/<area>/` when a shim or alias is found.

Do NOT review general correctness or duplication — separate agents cover those.

Inspect `git show --stat HEAD` and `git show HEAD`.

Report only actionable findings with file references and evidence.
```

Collect all three results before deciding whether to enter the fix loop (§5).

### 5. Review Fix Loop

If **any** of the three automated reviews finds actionable issues (including legacy/fallback cleanup in scope): 

Start a **new agent** to:
1. Fix only issues identified to the current commit;
2. Run the affected tests and `npm run build`.
3. Create a follow-up commit named as a fix/review commit, or amend only if all git safety requirements allow it and the user explicitly requested amend behavior.
4. Launch **three new** readonly review subagents on the new `HEAD` (same three prompts as §4). Do not resume prior review agents.

Do not start the next issue until **all three** reviews pass or the user explicitly defers a finding.

## Gates

- Stop if preflight fails.
- Stop if an issue is blocked by an incomplete dependency.
- Stop if the implementation agent reports unresolved acceptance criteria.
- Stop if tests or `npm run build` fail and cannot be fixed in scope.
- Stop if any automated review finds a critical issue that cannot be resolved without changing scope.

## Output Per Issue

Report briefly:

- Issue implemented.
- Commit hash and message.
- Tests/build run.
- Automated review results: regular, duplication, legacy/fallback (pass or findings).
- Any deferred risks approved by the user (including deferred legacy removal with blocker noted).

## Skill Index

- `implement` for the underlying FE pipeline and gates.
- `tdd` for issue implementation.
- `github-mcp` for tracker issues and PRs.
- `prd-to-issues` only if the user asks to create or revise issue breakdowns.
- `.cursor/rules/no-legacy-fallback-code.mdc` for legacy/fallback review criteria.

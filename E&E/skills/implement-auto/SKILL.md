---
name: implement-auto
description: >-
  Automated frontend implementation pipeline built on implement: accepts local
  PRD/issues or tracker issues, runs one fresh agent per issue, commits after
  each issue, and performs automated commit review including duplicate-code
  detection. Use when the user says /implement-auto, implement-auto, or asks to
  automatically implement issues from a PRD, issue folder, or tracker.
disable-model-invocation: true
---

# Implement Auto (`/implement-auto`)

Runs the `implement` workflow with an automated per-issue loop:

1. Resolve the PRD and issue list.
2. For each selected issue, launch a **new implementation agent**.
3. Commit that issue's completed changes.
4. Launch an **automated review agent** for the commit.
5. Fix review findings before moving to the next issue.

Invocation of `/implement-auto` grants permission to create one commit per completed issue unless the user says dry-run, no-commit, or review-only.

## Inputs

Accept either local artifacts or tracker artifacts.

**Local PRD and issues**

- PRD path, for example `docs/prd/{slug}.md`.
- Issue directory, for example `docs/issues/{slug}/`.
- Read the directory README plus each issue file. Treat numbered files as the implementation queue unless dependencies say otherwise.

**Issue tracker**

- Parent issue, PRD issue, or child issue references.
- Use `github-mcp` to read issue bodies, comments, and sub-issues. If only a parent is provided, gather child issues and order them by dependency/blocker fields.
- Do not use `gh` unless the user explicitly approves a fallback.

## Required Progress Tracker

Maintain this checklist in chat and update it after each issue:

```markdown
Implement-auto progress (source: ___):
- [ ] 0. Source resolved: PRD + issue queue
- [ ] 1. Preflight checked or documented as FE-only
- [ ] 2. Current issue: #/file ___
- [ ] 3. Fresh implementation agent completed current issue
- [ ] 4. Tests/lints/build passed
- [ ] 5. Commit created for current issue
- [ ] 6. Automated commit review passed
- [ ] 7. Review fixes committed or explicitly deferred
```

## Workflow

### 0. Resolve Source

Gather the PRD, issue list, dependencies, acceptance criteria, and any manual QA notes.

- Local issue files are durable source material; do not publish tracker issues unless the user asks.
- Tracker issues are source material; use local PRDs only as supporting context unless the tracker issue points to them.
- If both local and tracker sources are present, prefer the issue-specific acceptance criteria from the tracker and use local docs for extra context.

### 1. Preflight

Follow `implement` Stage 0:

- B+E work: backend issue is closed and the published OpenAPI contains the needed operations.
- FE-only work: document `**Backend:** None (FE-only)` and proceed.
- Read `docs/DESIGN.md` before UI, routing, app shell, feature boundary, or global styling/token changes.
- For UI changes, check `src/features/dev/components/KitchenSinkPage.tsx` before introducing or changing shared UI patterns.

### 2. Per-Issue Implementation Agent

For each issue, start a **new** subagent. Do not resume a previous implementation agent.

Use a prompt with:

- PRD path or tracker parent.
- The exact current issue body and acceptance criteria.
- Relevant dependency status.
- Repo rules: TDD, `npm run build`, no unrelated changes, no committing from inside the subagent unless explicitly requested.
- A request to return changed files, tests run, build result, and any unresolved risks.

The implementation agent should use `tdd`: one behavior at a time, green before refactor, tests through public interfaces. It must run targeted tests as appropriate and `npm run build` after code is complete.

### 3. Parent Verification And Commit

After the implementation agent returns:

1. Inspect `git status` and `git diff`.
2. Verify the diff is scoped to the current issue.
3. Run or confirm relevant tests and `npm run build`.
4. Create exactly one commit for the current issue using the repository's commit style.

Do not continue to the next issue while the working tree contains uncommitted changes from the current issue.

### 4. Automated Commit Review

After each commit, launch a **new readonly review agent** for `HEAD`. The review must be code-review oriented: bugs first, then missing tests, regressions, maintainability risks, and duplicated existing code.

The review prompt must require duplicate-code investigation:

```text
Review the HEAD commit. In addition to correctness, regressions, and tests,
actively look for new code that duplicates existing code or established UI/API
patterns. Search the codebase for similar components, hooks, helpers, API
mappers, styles, tests, fixtures, and domain logic before concluding there is
no duplication. For UI, compare against KitchenSinkPage and existing feature
patterns. Report only actionable findings with file references and evidence.
```

The review agent should inspect:

- `git show --stat HEAD` and `git show HEAD`.
- Existing code with similar names, behavior, copy, selectors, hooks, helpers, tests, and styles.
- Shared utilities, feature-local utilities, API edge mappers, kitchen-sink UI examples, and test helpers.
- Whether new abstractions are justified or whether existing ones should be reused.

### 5. Review Fix Loop

If the automated review finds actionable issues:

1. Fix only issues relevant to the current commit.
2. Run the affected tests and `npm run build`.
3. Create a follow-up commit named as a fix/review commit, or amend only if all git safety requirements allow it and the user explicitly requested amend behavior.
4. Run automated review again on the new HEAD.

Do not start the next issue until review passes or the user explicitly defers a finding.

## Gates

- Stop if preflight fails.
- Stop if an issue is blocked by an incomplete dependency.
- Stop if the implementation agent reports unresolved acceptance criteria.
- Stop if tests or `npm run build` fail and cannot be fixed in scope.
- Stop if automated review finds a critical issue that cannot be resolved without changing scope.

## Output Per Issue

Report briefly:

- Issue implemented.
- Commit hash and message.
- Tests/build run.
- Automated review result.
- Any deferred risks approved by the user.

## Skill Index

- `implement` for the underlying FE pipeline and gates.
- `tdd` for issue implementation.
- `github-mcp` for tracker issues and PRs.
- `prd-to-issues` only if the user asks to create or revise issue breakdowns.

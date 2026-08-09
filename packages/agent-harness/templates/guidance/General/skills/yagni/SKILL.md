---
name: yagni
description: >-
  Review changed code with three sequential passes: YAGNI/KISS, complexity
  depth, and class explosion. Use when the user says /yagni, yagni review, or
  asks to review changes for over-engineering, unnecessary abstractions,
  shallow modules, or class/file proliferation.
disable-model-invocation: true
---

# YAGNI Review

Review the changed code against the repository's base branch, or against the base branch named by the user.

Run **three sequential** review agents (not parallel). Wait for each to finish before launching the next.

| Order | Agent focus | Rubric |
|-------|-------------|--------|
| 1 | YAGNI and KISS | [YAGNI-KISS.md](YAGNI-KISS.md) |
| 2 | Complexity depth | [COMPLEXITY-DEPTH.md](COMPLEXITY-DEPTH.md) |
| 3 | Class explosion | [CLASS-EXPLOSION.md](CLASS-EXPLOSION.md) |

This skill is **read-only**. Do not fix findings unless the user asks.

## Preflight

1. **Repository path** — active workspace root (absolute path).
2. **Base branch** — use the branch named by the user; otherwise use the repository default branch.
3. **Resolve base branch** — prefer the local branch, then the matching remote branch. If the default branch is unclear, inspect the remote default branch, then common names such as `main`, `master`, `trunk`, or `develop`. If still missing, stop and ask the user for the correct base branch name.
4. **Current branch** — record `git branch --show-current`.
5. **Diff scope** — branch changes vs merge-base with the base branch:

```bash
git merge-base <base-ref> HEAD
git diff <base-ref>...HEAD --stat
git diff <base-ref>...HEAD
```

Default to **branch changes** (committed + staged + unstaged on the current branch vs merge-base). If the user asks for uncommitted-only review, use `git diff` / `git diff --cached` instead and say so in the report header.

6. **Empty diff** — if no changed files, tell the user in one sentence and stop. Do not launch agents.

7. **Changed-file list** — collect paths from the diff stat. Pass this list to every agent.

## Agent launches

Launch exactly one `generalPurpose` subagent per pass with:

- `readonly: true`
- `run_in_background: false`
- `description`: `"YAGNI — YAGNI/KISS"`, `"YAGNI — complexity depth"`, or `"YAGNI — class explosion"`

Read the matching rubric file **before** writing each agent prompt so criteria are accurate.

Use this prompt shape for each agent:

```text
Full Repository Path: <absolute path>
Base Branch: <base-ref>
Current Branch: <name>
Review Pass: <YAGNI/KISS | complexity depth | class explosion>
Changed Files:
- path/to/file.ts
- ...

Instructions:
1. Read <skill-directory>/<RUBRIC-FILE>.md for the review rubric.
2. Read applicable project rules, contributor docs, or architecture docs for the current workspace when present.
3. For each changed file, read the full file (not diff-only) and inspect direct callers/imports when needed for context.
4. Review ONLY the branch delta vs <base-ref> — new code, modified behaviour, deleted pass-throughs, and new exports. Do not nitpick untouched legacy code unless the change makes it worse.
5. Return findings sorted by severity (highest first).

Output format (markdown):

## <Review Pass> — summary
One sentence: N findings / no issues.

## Findings
| Severity | Location | Finding | Recommendation |
|----------|----------|---------|----------------|
| Critical / Suggestion / Nice-to-have | file:line | What violates the rubric | Concrete simplify/delete/merge action |

If no issues: say so explicitly and leave the findings table empty.
Do not propose fixes beyond the recommendation column. Do not edit files.
```

Replace `<RUBRIC-FILE>` with `YAGNI-KISS.md`, `COMPLEXITY-DEPTH.md`, or `CLASS-EXPLOSION.md`.

### Retry

If an agent fails before returning findings:

- Wrong prompt shape or missing repo path → fix and retry once immediately.
- Could not read diff or files → retry once with explicit file contents listed in the prompt.
- Same failure twice → stop that pass, note the blocker, continue to the next pass only if prior passes succeeded; otherwise stop entirely.

## Final report

After all three agents finish, synthesize for the user:

```markdown
# YAGNI review — `<current>` vs `<base-ref>`

**Scope:** N files changed

## Verdict
One paragraph: overall lean vs over-built; worst recurring theme across passes.

## Pass 1 — YAGNI / KISS
<agent summary + findings table or "no issues">

## Pass 2 — Complexity depth
<agent summary + findings table or "no issues">

## Pass 3 — Class explosion
<agent summary + findings table or "no issues">

## Top actions
Numbered list (max 5): highest-impact simplifications, deduped across passes.
```

Do not rerun review or implement fixes unless the user explicitly asks.

## Scope boundaries

Use this skill for simplicity and over-engineering review of a branch diff. If the user asks for correctness, security, dependency, or broad architecture review, use a more specific review workflow when one is available.

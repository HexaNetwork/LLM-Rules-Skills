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

Shared pass order, agent launch, prompt shape, retry, and report body: [ORCHESTRATION.md](ORCHESTRATION.md).

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

## Run the three passes

Follow [ORCHESTRATION.md](ORCHESTRATION.md). For each agent:

- **Descriptions:** `"YAGNI — YAGNI/KISS"`, `"YAGNI — complexity depth"`, `"YAGNI — class explosion"`
- **SCOPE-HEADER:**
  ```text
  Base Branch: <base-ref>
  Current Branch: <name>
  ```
- **FILE-LIST:** `Changed Files:` then the paths from preflight
- **Scope rule (instruction 4):** Review ONLY the branch delta vs `<base-ref>` — new code, modified behaviour, deleted pass-throughs, and new exports. Do not nitpick untouched legacy code unless the change makes it worse.

## Final report

```markdown
# YAGNI review — `<current>` vs `<base-ref>`

**Scope:** N files changed

<ORCHESTRATION.md final report body>
```

## Scope boundaries

Use this skill for simplicity and over-engineering review of a branch diff. For full-package inventory review, use `yagni-packages`. If the user asks for correctness, security, dependency, or broad architecture review, use a more specific review workflow when one is available.

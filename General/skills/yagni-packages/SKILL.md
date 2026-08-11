---
name: yagni-packages
description: >-
  Run a YAGNI inventory review on one package from docs/yagni-packages.json
  (full package scope, not branch diff). Use when the user says /yagni-package,
  yagni package review, or asks to review a package boundary for over-engineering.
disable-model-invocation: true
---

# YAGNI Package Review

Inventory review for a **single package** defined in `docs/yagni-packages.json` — every file in package scope, not the branch delta.

For branch-diff review, use [`yagni`](../yagni/SKILL.md). Shared orchestration (passes, agents, retry, report body): [`ORCHESTRATION.md`](../yagni/ORCHESTRATION.md). Rubrics live beside that file.

This skill is **read-only**. Do not fix findings unless the user asks.

## Package vs branch

| | Branch `yagni` | Package `yagni-packages` |
|--|----------------|--------------------------|
| Scope | `git diff <base>...HEAD` | All files under package `paths` |
| Goal | Catch over-engineering in the change | Catch accumulated YAGNI debt in a slice |
| Legacy | Only when the diff touches it | Entire package |

## Preflight

1. **Repository path** — active workspace root (absolute path).
2. **Load manifest** — read `docs/yagni-packages.json`.
3. **Select package** — use the `id` the user named; if omitted, list ids/titles and ask.
4. **Resolve entry** — record `title`, `description`, `paths`, `testPaths`, `excludePaths`.
5. **Expand file list** — resolve `paths` globs from repo root, subtract `excludePaths`, include matching `testPaths` when present (read implementation first).
6. **Respect `outOfScope`** — skip unless the user expands scope.
7. **Empty package** — if zero files, report in one sentence and stop.

Report header must include package `id`, `title`, file count, and that scope is **inventory** (not branch diff).

## Run the three passes

Follow [ORCHESTRATION.md](../yagni/ORCHESTRATION.md). For each agent:

- **Descriptions:** `"YAGNI package — YAGNI/KISS"`, `"YAGNI package — complexity depth"`, `"YAGNI package — class explosion"`
- **SCOPE-HEADER:**
  ```text
  Package ID: <id>
  Package Title: <title>
  Review Mode: package inventory (NOT branch diff)
  ```
- **FILE-LIST:** `Package Files:` then the expanded paths
- **Rubric path:** `../yagni/<RUBRIC-FILE>.md` from this skill directory
- **Scope rule (instruction 4):** Review the entire package inventory — flag unnecessary abstractions, shallow modules, and file/type proliferation even in legacy code.

## Final report

```markdown
# YAGNI package review — `<package-id>`

**Package:** <title>
**Scope:** N source files (+ M test files) — inventory review (not branch diff)
**Manifest:** docs/yagni-packages.json

<ORCHESTRATION.md final report body>
```

## Related skills

| Skill | Role |
|-------|------|
| `yagni` | Branch diff vs resolved base |
| `yagni-packages` | Full-package inventory (this skill) |
| `find-code-duplication` | Mechanical clone scan |
| `improve-codebase-architecture` | Exploratory deepening, not rubric-scored inventory |
| `rip-and-tear` | Execute aggressive refactors after approval |

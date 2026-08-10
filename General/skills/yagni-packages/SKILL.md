---
name: yagni-packages
description: >-
  Run a YAGNI inventory review on one package from docs/yagni-packages.json
  (full package scope, not branch diff). Use when the user says /yagni-package,
  yagni package review, or asks to review a package boundary for over-engineering.
disable-model-invocation: true
---

# YAGNI Package Review

Inventory review for a **single package** defined in `docs/yagni-packages.json`. This is **package mode** — review every file in the package scope, not the branch delta.

For branch-diff review against the repository's resolved default base branch, use the [`yagni`](../yagni/SKILL.md) skill instead.

This skill is **read-only**. Do not fix findings unless the user asks.

## Rubrics (same as branch YAGNI)

Run **three sequential** review passes per package. Reuse the parent skill rubrics:

| Order | Agent focus | Rubric |
|-------|-------------|--------|
| 1 | YAGNI and KISS | [YAGNI-KISS.md](../yagni/YAGNI-KISS.md) |
| 2 | Complexity depth | [COMPLEXITY-DEPTH.md](../yagni/COMPLEXITY-DEPTH.md) |
| 3 | Class explosion | [CLASS-EXPLOSION.md](../yagni/CLASS-EXPLOSION.md) |

In package mode, apply each rubric to **the whole package inventory** (existing code included), not only files changed on the current branch.

## Preflight

1. **Repository path** — active workspace root (absolute path).
2. **Load manifest** — read `docs/yagni-packages.json`.
3. **Select package** — use the `id` the user named. If omitted, list the package ids and titles present in the manifest and ask which to review.
4. **Resolve package entry** — find the object in `packages` where `id` matches. Record `title`, `description`, `paths`, `testPaths`, and `excludePaths`.
5. **Expand file list** — for each entry in `paths`, resolve globs from the repo root (`**` supported). Union results, then subtract any file matching `excludePaths`. Include matching unit tests from `testPaths` when present (tests inform depth/explosion; still read implementation files first).
6. **Respect out of scope** — do not review paths listed in manifest `outOfScope` unless the user explicitly expands scope.
7. **Empty package** — if expansion yields zero files, report that in one sentence and stop.

Record in the report header: package `id`, `title`, file count, and that scope is **inventory** (not branch diff).

## Package inventory mode vs branch diff

| | Branch `yagni` skill | Package `yagni-packages` skill |
|--|----------------------|--------------------------------|
| Scope | `git diff <base>...HEAD` (base resolved by `yagni`) | All files under package `paths` |
| Goal | Catch over-engineering in the change | Catch accumulated YAGNI debt in a slice |
| Legacy code | Review only when the diff touches it | Review entire package |
| Output | Chat summary | Chat summary |

## Agent launches

Launch exactly one `generalPurpose` subagent per pass with:

- `readonly: true`
- `run_in_background: false`
- `description`: `"YAGNI package — YAGNI/KISS"`, `"YAGNI package — complexity depth"`, or `"YAGNI package — class explosion"`

Read the matching rubric file **before** writing each agent prompt.

Use this prompt shape for each agent:

```text
Full Repository Path: <absolute path>
Package ID: <id>
Package Title: <title>
Review Mode: package inventory (NOT branch diff)
Review Pass: <YAGNI/KISS | complexity depth | class explosion>
Package Files:
- path/to/file.ts
- ...

Instructions:
1. Read `../yagni/<RUBRIC-FILE>.md`, resolved from this skill directory, for the review rubric.
2. Read any project KISS/SOLID rules selected by the harness; do not assume a tool-specific rules directory.
3. For each package file, read the full file and inspect direct callers/imports when needed for context.
4. Review the entire package inventory — flag unnecessary abstractions, shallow modules, and file/type proliferation even in legacy code.
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
- Could not read files → retry once with explicit file contents listed in the prompt.
- Same failure twice → stop that pass, note the blocker; continue to the next pass only if prior passes succeeded.

## Final report

After all three agents finish, synthesize for the user:

```markdown
# YAGNI package review — `<package-id>`

**Package:** <title>
**Scope:** N source files (+ M test files) — inventory review (not branch diff)
**Manifest:** docs/yagni-packages.json

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

## Relationship to other skills

| Skill | Role |
|-------|------|
| `yagni` | Branch diff review against the resolved base branch |
| `yagni-packages` | Full-package inventory review (this skill) |
| `find-code-duplication` | Mechanical clone scan; use when user wants DRY/consolidation |
| `improve-codebase-architecture` | Exploratory deepening analysis, not rubric-scored inventory |
| `rip-and-tear` | Execute aggressive refactors after review approval |

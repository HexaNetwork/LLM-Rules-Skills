# YAGNI Shared Orchestration

Shared mechanics for branch (`yagni`) and package (`yagni-packages`) reviews. Skills own **preflight/scope** and **report header**; this file owns pass order, agent launch, prompt shape, retry, and final synthesis.

## Passes

Run **three sequential** review agents (not parallel). Wait for each to finish before launching the next.

| Order | Agent focus | Rubric |
|-------|-------------|--------|
| 1 | YAGNI and KISS | [YAGNI-KISS.md](YAGNI-KISS.md) |
| 2 | Complexity depth | [COMPLEXITY-DEPTH.md](COMPLEXITY-DEPTH.md) |
| 3 | Class explosion | [CLASS-EXPLOSION.md](CLASS-EXPLOSION.md) |

Read-only unless the user asks to fix.

## Agent launches

Launch exactly one `generalPurpose` subagent per pass with:

- `readonly: true`
- `run_in_background: false`
- `description`: skill-specific label (e.g. `"YAGNI — YAGNI/KISS"` or `"YAGNI package — YAGNI/KISS"`)

Read the matching rubric file **before** writing each agent prompt.

### Prompt shape

```text
Full Repository Path: <absolute path>
<SCOPE-HEADER lines from the calling skill>
Review Pass: <YAGNI/KISS | complexity depth | class explosion>
<FILE-LIST from the calling skill>

Instructions:
1. Read <skill-directory>/<RUBRIC-FILE>.md for the review rubric.
2. Read applicable project rules / architecture docs for the workspace when present.
3. For each listed file, read the full file and inspect direct callers/imports when needed.
4. Apply the calling skill's scope rule (branch delta only vs whole package inventory).
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
- Same failure twice → stop that pass, note the blocker; continue to the next pass only if prior passes succeeded; otherwise stop entirely.

## Final report body

After all three agents finish, synthesize:

```markdown
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

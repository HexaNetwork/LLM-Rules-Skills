# Consolidated YAGNI report template

Merge the three agent outputs into one document. Replace placeholders.

```markdown
# <Feature or branch short name> — YAGNI Review Plan

**Branch:** `<head>` vs base `<base>`
**Scope:** ~<N> lines changed across <areas>
**Reviews:** YAGNI/KISS (<verdict1>), Complexity Depth (<verdict2>), Class Explosion (<verdict3>)

---

## Executive Summary / Overall Verdict

<2–4 sentences: how many lenses request changes; must-fix themes; strong follow-ups; defer items.>

**Must address before merge:** <bullets>

**Strong follow-ups:** <bullets>

**Defer / trim:** <bullets>

---

## Phase 1 — Merge Blockers

Must fix before merging `<head>` into `<base>`.

<For each High-severity finding from any lens — deduplicated:>

### 1.N <short title>

| | |
|---|---|
| **Severity** | High |
| **Sources** | YAGNI/KISS, Complexity Depth, Class Explosion (list all that flagged it) |
| **Problem** | |
| **Action** | |
| **Files** | |

---

## Phase 2 — High Priority Post-Blocker

<Wiring, perf, duplication — Medium+ severity, or High deps on Phase 1 outcomes. Same table shape; **Severity** may be Medium or Low–Medium.>

---

## Phase 3 — Consolidation / YAGNI Trims

<Type-count and indirection reductions once Phase 1–2 stable. Not blockers unless team policy says otherwise.>

---

## Keep As-Is

Union of positive findings. Drop anything invalidated by Phase 1.

| Item | Sources | Notes |
|------|---------|-------|
| ... | YAGNI, Complexity, Class Explosion | |

**Caveat:** Note conditional positives (e.g. "wired in module but unused in prod").

---

## Master Checklist

| # | Item | Severity | Source review(s) | Action | Primary files |
|---|------|----------|------------------|--------|---------------|
| 1.1 | ... | High | YAGNI, Class Explosion | ... | ... |

---

## Suggested Implementation Order

1. Phase 1 items (fastest scope wins first when obvious)
2. Phase 1 dependencies that unblock Phase 2
3. Phase 2 perf / dedup
4. Phase 3 consolidation when behavior is stable
```

## Merge rules

- Same underlying issue from two lenses → **one** Phase entry, **Sources** lists both.
- Severity = max across lenses.
- Verdict in header uses all three parenthetical verdicts.
- Omit empty phases.
- Do not add findings the agents did not support with diff evidence.

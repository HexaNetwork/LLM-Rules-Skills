# Complexity depth review lens

**Question:** Are modules **deep** (small interface, large leverage) rather than **shallow** (interface nearly as complex as the implementation)?

Use vocabulary from `.cursor/skills/improve-codebase-architecture/LANGUAGE.md`: **module**, **interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**, **deletion test**.

## Read first

- `.cursor/skills/improve-codebase-architecture/LANGUAGE.md`
- `.cursor/rules/java-unit-tests-no-bukkit.mdc` (static init / untestable seams)

## Flag

| Signal | Examples |
|--------|----------|
| **Shallow modules** | Callers must know ordering, error modes, and config that should be hidden |
| **Algorithmic waste** | O(n²) or repeated full rebuilds on hot paths (GUI open, deposit, daily tick) |
| **Duplicated branching** | Same discriminator / state machine copied across presentation, application, and facade |
| **Error erasure** | Distinct failure modes collapsed to `null`, empty optional, or one enum value |
| **Confusing control flow** | Cache/create paths that are hard to follow; double computation (`derive all` then filter one) |
| **Pass-through with tax** | Module adds indirection without concentrating complexity (failed deletion test) |
| **Test friction** | Logic only reachable through Bukkit/static globals — deepening would improve locality |

## Positive signals (Keep as-is)

- Staged pipeline with clear steps at one entry point
- Row/state enums encapsulating UI rules
- Repositories matching existing CivCraft persistence patterns
- Good unit coverage on core algorithms (note gaps separately)
- Derive-at-read core types with focused responsibilities

## Severity guide

| Level | When |
|-------|------|
| **High** | Player-visible perf (GUI, tick) or correctness risk from error erasure |
| **Medium** | Hot-path redundant work; duplicated branching that will drift |
| **Low** | Nested loops in presentation; pre-existing nits touched by the diff |

## Output template

Return markdown in this shape:

```markdown
## Complexity depth review

**Verdict:** Approve | Approve with nits | Request changes

### Findings

For each finding:

| | |
|---|---|
| **Severity** | High / Medium / Low |
| **Problem** | One sentence — name the shallow module or wasted work |
| **Action** | Deepening step (level-scoped API, single parser, typed result, cache seam, extract method) |
| **Files** | Primary paths |

### Keep as-is

| Item | Notes |
|------|-------|
| ... | Depth / leverage / locality win |

### Summary

2–3 sentences: perf vs shape vs testability; recommended next step.
```

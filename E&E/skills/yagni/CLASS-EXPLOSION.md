# Class explosion review lens

**Question:** Does the branch add **more types than the feature earns**, especially `*Service`, `*Helper`, DTO stacks, and test-only adapters?

## Read first

- `.cursor/rules/prefer-few-service-classes.mdc`
- `.cursor/rules/java-prefer-keyvaluepair-for-pairs.mdc`
- `.cursor/rules/java-no-empty-constructors.mdc`
- `.cursor/rules/new-listener-handlers.mdc` (no new `Listener` classes)
- `.cursor/rules/java-no-nested-classes.mdc`

## Flag

| Signal | Examples |
|--------|----------|
| **New `*Service` / `*Helper` / `*Resources`** | Especially one public method, 1–2 call sites |
| **Parallel stack** | New repository + service mirroring an existing ledger/manager |
| **DTO sprawl** | Request/result/input types for a single workflow with no reuse |
| **Two-field records** | Prefer `KeyValuePair` unless a named domain concept crosses modules |
| **Interface + impl for tests only** | `FooPort` + `FooAdapter` with one production impl |
| **Package split for one entry point** | Six public types where one owner + private helpers suffices |
| **Duplicate domain paths** | Two classes solving the same planting/harvest/level problem |
| **Misplaced util types** | Static one-liners that should live on manager, command, or window |
| **Double registration** | Same calculator/service constructed twice in module wiring |
| **New `implements Listener`** | Should be `NewListener` handler list instead |

## Positive signals (Keep as-is)

- No new standalone listeners — handlers under `listener/<event>/`
- `KeyValuePair` where appropriate
- Normal UI surface (a few windows for a feature)
- Config / persistence POJOs at real boundaries
- Focused factory when it owns non-trivial construction rules
- Named domain types (`WorkOrderSegment`-style) when the concept is public across config, derivation, and UI

## Severity guide

| Level | When |
|-------|------|
| **High** | Parallel stack vs existing owner; dead types; production path bypasses registered service |
| **Medium** | Mergeable single-method types; test-only adapters; extra service for one concern |
| **Low** | Defer merge until third consumer; record vs KVP disagreement on true domain types |

## Output template

Return markdown in this shape:

```markdown
## Class explosion review

**Verdict:** Approve | Approve with nits | Request changes

### Findings

For each finding:

| | |
|---|---|
| **Severity** | High / Medium / Low |
| **Problem** | One sentence — list type names when helpful |
| **Action** | Delete, merge into named owner, fold into existing type, or defer |
| **Files** | Primary paths |

### Keep as-is

| Item | Notes |
|------|-------|
| ... | Why type count is justified |

### Summary

2–3 sentences: type-count delta, parallel stacks, recommended next step.
```

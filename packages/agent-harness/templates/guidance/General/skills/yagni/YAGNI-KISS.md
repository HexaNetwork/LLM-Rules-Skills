# YAGNI / KISS rubric

Review the branch delta for code that **does not earn its keep today**.

## YAGNI — You Aren't Gonna Need It

Flag when the change adds capability **without a current caller or requirement**:

- Config flags, feature toggles, or env knobs for behaviour not shipped yet
- Generic parameters / type parameters unused by current call sites
- "Future-proof" extension points (plugin APIs, strategy registries) with one implementation
- Abstractions wrapping a single concrete implementation with no second adapter planned
- Error handling, validation, or retry layers for failures that cannot happen on the current path
- Exported symbols nothing in the diff (or repo) imports yet
- Dual code paths (`if (useNewX) … else …`) when migration is complete or only one path is live
- Compat shims, deprecated aliases, or fallbacks (`newField ?? oldField`) after migration

**Pass** when the extra generality removes real duplication **now** (3+ call sites) or satisfies an explicit requirement in scope.

## KISS — Keep It Simple

Read applicable project rules or contributor docs when present. Flag violations such as:

- Clever abstractions where a direct function, component, or inline branch is clearer
- Deep nesting — prefer early returns and flat control flow
- Premature extraction — helpers used once, or 1–2-line wrappers around one call
- Factory patterns or class hierarchies where a function or composition suffices
- New `*Service`, `*Helper`, `*Utils`, `*Manager` modules with one method or one caller
- Orchestration layers doing domain work that belongs in a smaller owner module
- Over-broad inputs/interfaces when callers need only a few fields
- Re-implementing existing shared components, helpers, or utilities instead of reusing them

## Severity guide

| Severity | When |
|----------|------|
| **Critical** | Dead code path, unused abstraction layer, or complexity that blocks the obvious simple fix |
| **Suggestion** | Simpler shape exists; change works but costs ongoing maintenance |
| **Nice-to-have** | Minor verbosity; three similar lines that could stay as-is per project rules |

## Recommendation bar

Every finding must name a **concrete** simplify action: delete, inline, merge into owner, use existing shared code, or defer the abstraction until a third caller exists.

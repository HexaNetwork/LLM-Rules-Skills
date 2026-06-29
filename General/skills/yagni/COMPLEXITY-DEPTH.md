# Complexity depth rubric

Review the branch delta for **shallow modules** and **interface bloat** — places where callers must learn almost as much as the implementation provides.

Use the "deep module" lens: prefer small interfaces that hide meaningful behaviour over broad interfaces that merely forward complexity.

## Depth — what to measure

A module (function, class, component, file) is **deep** when a lot of behaviour sits behind a **small interface**. It is **shallow** when the interface is nearly as complex as the implementation.

Review **only new or materially changed modules** in the diff.

## Flag shallow modules

- Pass-through wrappers — thin re-exports, delegating modules, or components that only forward inputs
- Interface nearly matches implementation — many inputs/methods for little unique logic
- Split files that always change together and share one responsibility (visual-only splits)
- Public interfaces with many inputs doing orchestration **and** domain logic — should split by behaviour
- APIs that expose many setters/state slices when one cohesive operation or return shape would suffice
- Exported types/functions that exist only to satisfy one internal caller
- Tests that mock past the module boundary because the interface is too wide to test through

Apply the **deletion test**: if deleting the module makes complexity vanish, it was a pass-through. If complexity reappears across N callers, the module is load-bearing — do not flag it as shallow.

## Flag missing depth (when complexity leaked outward)

- Business rules duplicated across callers instead of behind one module interface
- Callers must know ordering, error modes, or config that should be hidden inside one owner
- Feature logic spread across parallel `switch` / `if (type === X)` chains instead of one dispatch owner

## Seam discipline

- **One adapter = hypothetical seam.** Do not flag a single implementation behind an interface unless the diff adds abstraction with no variation.
- **Two adapters = real seam.** Passing abstraction is fine when two implementations exist in the diff or are required in scope.

## Severity guide

| Severity | When |
|----------|------|
| **Critical** | New shallow layer in the hot path; callers must learn redundant surface area |
| **Suggestion** | Module could be deepened or inlined; maintenance cost, not immediate harm |
| **Nice-to-have** | Minor interface noise; depth could improve testability later |

## Recommendation bar

Recommend **deepen** (hide complexity behind smaller interface), **inline** (delete pass-through), or **consolidate** (one owner for scattered rules). Name the target owner module or function.

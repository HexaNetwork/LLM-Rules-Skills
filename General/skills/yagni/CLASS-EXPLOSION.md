# Class explosion rubric

Review the branch delta for **proliferation of types, files, and layers** — especially when a simpler shape would satisfy current needs.

"Class explosion" includes unnecessary **classes**, **types**, **files**, **folders**, and **parallel hierarchies**, not only language-level `class` keywords.

## Count what the diff adds

Tally net-new in the branch vs the resolved base branch:

- Files and folders under the touched area
- Exported classes, interfaces, types, enums, or public data shapes
- Thin wrapper modules that only forward to one implementation
- One-off helpers or abstractions created per field, endpoint, or variant
- State containers, registries, or coordinators introduced where local ownership would suffice
- Parallel modules (`FooService`, `FooRepository`, `FooHelper`) for one feature slice

Compare to **what the change actually needs** — not what a fully generic platform would need.

## Flag class / file explosion

- New file whose entire public API is used by **one** importer in the diff
- Sibling types (`XHandler`, `XProcessor`, `XAdapter`, `XFactory`) that differ by one branch — candidate for merge or config-driven dispatch
- Inheritance or composition trees where parameters or small extensions would suffice
- Duplicate parallel components or modules when an existing building block already accepts variants
- Splitting one cohesive module into many files without separate ownership or test seams
- New abstraction folder (`strategies/`, `adapters/`, `factories/`) with a single member
- Types exported "for reuse" with no second consumer in the diff
- Growing oversized files instead of splitting by behaviour and ownership

## Common anti-patterns

```text
❌ Wrapper — one call site
❌ God *Service / *Helper with one method
❌ Parallel module when an existing owner already fits
❌ Factory for two variants that a simple parameter could distinguish

✅ Shared on an existing base; variant via a small override
✅ One owner per lifecycle or responsibility
✅ Extract only when 3+ unrelated call sites need the same block
```

## Pass when proliferation is justified

- Split reduces an oversized module by **behaviour**, not incidental fragments
- Two real adapters at a seam (see COMPLEXITY-DEPTH.md)
- New files map to distinct entry points, features, or test-owned boundaries that change independently
- Generated or schema-driven types that mirror distinct external contracts (do not merge different shapes)

## Severity guide

| Severity | When |
|----------|------|
| **Critical** | Many new files/types for one behaviour; clear single-owner alternative |
| **Suggestion** | Extra type or file adds navigation cost; merge candidate |
| **Nice-to-have** | Naming/placement could be flatter; structure still readable |

## Recommendation bar

Recommend **delete**, **merge into** `<owner>`, **collapse** siblings, or **reuse** an existing module. Quote the files to remove or fold together.

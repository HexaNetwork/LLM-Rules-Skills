---
name: rip-and-tear
description: >-
  Aggressively recodes a feature by tearing apart individually coded pieces and
  re-assembling them into a coherent foundation — less duplication, less
  complexity, more generic base-class reuse, fewer one-off wrappers. Use when
  the user says rip-and-tear, /rip-and-tear, "recode this feature", "tear this
  apart", consolidate a messy feature, or wants aggressive refactor over
  incremental cleanup.
disable-model-invocation: true
---

# Rip and Tear

**Goal:** Take a feature that grew as one-off pieces and **re-assemble** it into a coherent foundation. Delete or fold what does not earn its keep. Prefer existing base types and owners over new abstractions.

This skill **implements** refactors. For scan-only duplication reports use `find-code-duplication`. For architecture review without coding use `improve-codebase-architecture`.

## Mindset

| Rip | Tear |
|-----|------|
| Delete wrapper-only types | Inline logic that only forwards |
| Merge duplicate branches | Collapse parallel hierarchies |
| Move shared code up the inheritance chain | Push variant code down to overrides |
| Fold 1–2 call-site helpers into the owner | Replace god classes with focused handlers |

**Bias:** fewer files, fewer layers, one obvious place for each rule. When two shapes do the same job, pick the **existing** canonical type (`Buildable` → `Structure` → `Farm`, `*Manager`, `*Repository`, `NewListener` handler lists).

Apply the **deletion test** from [improve-codebase-architecture/LANGUAGE.md](../improve-codebase-architecture/LANGUAGE.md): if deleting a class makes complexity vanish, delete it. If complexity reappears at every caller, the class was load-bearing — move it, do not duplicate it.

## Scope first

Confirm with the user (or infer):

| Input | Default |
|-------|---------|
| Feature / package path | User-named folder or ticket area |
| Behaviour must stay identical | Yes — unless user approves intentional changes |
| Test safety net | Required — follow `tdd` (characterization before rip) |
| Out of scope | Unrelated packages, drive-by style fixes |

Record scope in the progress checklist header.

## Progress checklist

Copy and tick as you go:

```
Rip-and-tear (feature: ___ / paths: ___):
- [ ] 1. Recon — map pieces, call graph, duplication, wrappers
- [ ] 2. Target shape — user approves foundation plan
- [ ] 3. Safety net — characterization tests for behaviours at risk
- [ ] 4. Rip slices — vertical delete/merge/move (one slice at a time)
- [ ] 5. Reassemble — wire owners, handlers, base-class hooks
- [ ] 6. Verify — tests green, compile, smoke notes
```

Do **not** start deleting code until step 3 has tests for the behaviours you will touch.

---

## 1. Recon

Explore the scoped feature. Return a **Rip map** (not a refactor yet).

### Map these

1. **Entry points** — commands, listeners, windows, scheduled tasks, config load.
2. **Owners** — which `*Manager`, `*Repository`, domain type should own lifecycle and rules.
3. **Duplication** — copy-paste blocks, parallel `if (type == X)` chains, twin classes differing by one field.
4. **Wrappers** — types whose entire public API forwards to one other type (especially 1–2 call sites). Apply deletion test.
5. **Hierarchy gaps** — siblings that repeat `Structure` / `Buildable` / processor logic instead of sharing a base or template method.
6. **Seam violations** — `*Listener` god objects, `*Service` / `*Helper` / `*Utils` with one method, thin `CivSettings` getters.

Use parallel `subagent_type=Explore` when the feature spans multiple packages. Optionally run `find-code-duplication` scoped to the feature for mechanical clones — triage hits before acting.

### Rip map template

Present to the user:

```markdown
## Rip map — [feature]

### Keep (load-bearing)
- `ClassName` — why it earns its place

### Delete / inline (wrapper-only or pass-through)
- `ClassName` → fold into `Owner` — N call sites

### Merge (duplication)
- `A` + `B` → shared `BaseOrHelperOnOwner` — what differs stays override/config

### Move up (generic)
- repeated in `Farm`, `Pasture`, `Granary` → `Structure` or `StructureProcessor`

### Move down (specific)
- generic method with 5 type switches → overrides on concrete types

### Open questions
- ...
```

**Gate:** Ask which rip map rows to execute (all, numbered subset, or revise plan). Do not rip without approval.

---

## 2. Target shape

For approved rows, sketch the **after** picture in plain English:

- **Single owner** per lifecycle (one manager, one repository).
- **Base class** holds shared algorithm; subclasses override hooks (`Buildable`, `Structure`, `StructureProcessor`, `CommandBase`, handler interface).
- **Handlers** for Bukkit events — `NewListener` list + `listener/<eventname>/` impls, not new `Listener` classes (see workspace rule `new-listener-handlers.mdc`).
- **No new** `*Service`, `*Helper`, `*Resources` unless 3+ unrelated call sites need the same non-trivial block (`prefer-few-service-classes.mdc`).

Project-specific consolidation targets: copy [PROJECT-PATTERNS.example.md](PROJECT-PATTERNS.example.md) to `PROJECT-PATTERNS.md` and edit for the repo (or follow the example as-is when it matches).

---

## 3. Safety net (TDD)

Read and follow the **`tdd` skill**. Rip-and-tear is refactor-heavy — **characterization tests before each rip slice**.

For each approved rip row:

1. Identify **behaviour** callers rely on (not private method names).
2. **RED** — test current behaviour at the public seam (manager method, handler outcome, codec round-trip, window action). Project unit tests run — extract or inject when needed ([tdd/tests.md](../tdd/tests.md)).
3. **GREEN** — tests pass on unchanged code.
4. Only then proceed to step 4 for that slice.

One **vertical** slice: characterize → rip → reassemble → green. Do not batch all tests then all deletes.

---

## 4. Rip slices

Execute **one approved row at a time**. Order:

1. **Inline wrappers** — delete type, fix imports, run tests.
2. **Merge duplicates** — extract shared body to base class or private method on owner; delete duplicate.
3. **Move up** — elevate to parent class; replace overrides with `super` calls where identical.
4. **Move down** — replace switches with polymorphism or config-driven dispatch.
5. **Rewire entry points** — commands, windows, handlers point at the new owner only.

### Rip rules

| Do | Don't |
|----|-------|
| Delete the wrapper in the same commit/slice as rewiring callers | Leave deprecated shims "for later" |
| Prefer `protected` hooks on existing base classes | Introduce parallel inheritance trees |
| Fold 1–2 call-site helpers into command/manager/window | Add a new util class to avoid touching the owner |
| Keep slice diff reviewable (~one rip map row) | Boil-the-ocean refactors across unrelated features |
| Match surrounding naming and package layout | Rename unrelated identifiers for "cleanliness" |

When ripping listeners: migrate logic into handler impls; remove god `*Listener` forwarders; register on `NewListener` lists only.

When ripping structures: shared build/process/deposit logic belongs on `Structure`, `StructureProcessor`, or `Buildable` — not a new `FarmHelper`.

---

## 5. Reassemble

After each slice, confirm the foundation holds:

- [ ] One clear owner for persistence and rules
- [ ] Event flow goes through `NewListener` handler lists (if applicable)
- [ ] Subtypes only contain **variant** logic
- [ ] Config read inline via `CivSettings.get*OrDefault` at use site — no thin getters
- [ ] No new empty constructors (`java-no-empty-constructors.mdc`)

Update call sites in the same slice — no half-migrated feature.

---

## 6. Verify

Per slice:

- Run affected unit tests.
- Fix compile errors before the next slice.
- Note manual smoke steps if Bukkit-only paths lack unit coverage.

When all approved rows are done, summarize:

```markdown
## Rip-and-tear complete — [feature]

### Removed
- ...

### Consolidated into
- ...

### Tests added/updated
- ...

### Manual smoke (if any)
- ...
```

---

## Relationship to other skills

| Skill | Role |
|-------|------|
| `rip-and-tear` | **Execute** aggressive feature recode |
| `find-code-duplication` | Find clone clusters; optional input to recon |
| `improve-codebase-architecture` | Deepening analysis + grilling; use before rip if shape is unclear |
| `tdd` | **Required** characterization and vertical slices |
| `grill-me` | Use when target shape or trade-offs are still ambiguous |

## Anti-patterns (delete on sight)

```java
// ❌ Wrapper — one call site
public final class FarmDepositHelper {
    public static void deposit(Farm farm, ItemStack stack) {
        farm.getLedger().deposit(stack);
    }
}

// ❌ God listener forwarded from NewListener
dungeonListener.onMoveEvent(event);

// ❌ Parallel hierarchy when Structure already fits
public class FarmLogic { /* duplicates Structure build rules */ }

// ✅ Shared on base; Farm overrides hook
public class Farm extends Structure {
    @Override
    protected void onProcessComplete() { /* farm-only */ }
}

// ✅ Handler owns feature logic
public class BlockBreakFarm implements BlockBreakHandler {
    @Override
    public void handle(BlockBreakEvent event) { /* ... */ }
}
```

## Additional resources

- Project consolidation patterns: [PROJECT-PATTERNS.example.md](PROJECT-PATTERNS.example.md)

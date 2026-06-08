# CivCraft patterns for rip-and-tear

Where to consolidate when tearing apart a feature in this repo.

## Type hierarchy (prefer moving up)

| Layer | Examples | Shared behaviour belongs here |
|-------|----------|-------------------------------|
| `Buildable` | Town structures, wonders, camps | Build state, templates, ownership, generic save/load hooks |
| `Structure` | `Farm`, `Granary`, `Marketplace`, `Pasture` | Town integration, level display, urban planner registration |
| `Wonder` | Capitol wonders | Wonder-specific control points, shared wonder rules |
| `StructureProcessor` | `TrommelProcessor`, `QuarryProcessor`, `SawmillProcessor` | Tick/process loops shared across processor structures |

**Rip signal:** two or more siblings with the same 10+ line method → extract to parent as `protected` template method or shared private helper on the parent.

**Keep on subclass:** display names, config keys, yield tables, one-off permissions — only what truly varies.

## Event handling

Canonical pattern: `NewListener` + handler interface + impl list.

```
listener/blockbreakevent/BlockBreakHandler.java   ← interface
listener/blockbreakevent/BlockBreakFarm.java      ← feature impl
NewListener.blockBreakHandlers                    ← List.of(...)
NewListener.onBlockBreak                          ← single @EventHandler loop
```

**Rip:** Any `implements Listener` registered outside `NewListener` for gameplay → migrate to handler impl, delete listener class.

**Rip:** Handler that only calls `SomeListener.onXxx()` → move logic into handler, delete god listener.

## Ownership

| Concern | Natural owner |
|---------|----------------|
| Player/resident progression | `*Manager` (e.g. `ResidentQuestManager`) |
| Load/save | `*Repository` + state POJO |
| Player-facing actions | `*Command` (`CommandBase`) |
| One-off UI | Existing `*Window` / button classes |
| Admin force/reset/inspect | `Admin*Command` under `/ad` |

**Rip:** Logic in a command that belongs in a manager → move to manager, command stays thin.

**Rip:** Repository doing business rules → move rules to manager, repository persists only.

## Config

Read at use site:

```java
CivSettings.getDoubleOrDefault(CivSettings.questSettingsConfig, "guide.reposition_distance", 20.0);
```

**Rip:** Delete thin static getters on `CivSettings` when touching call sites.

## Classes to delete (usual suspects)

| Pattern | Action |
|---------|--------|
| `*Helper`, `*Utils`, `*Resources` with 1–2 call sites | Inline into owner |
| `*Service` delegating to one manager | Call manager directly |
| Codec/parser wrapper around one method | Merge into repository or domain type |
| Duplicate window with one label change | Parameterize existing window or shared builder method on owner window |
| `private static` util on new file | `private` method on class that owns the workflow |

## Extraction threshold

From `prefer-few-service-classes.mdc`:

- **2 call sites:** tolerate duplication or `private` method on owner
- **3+ unrelated modules:** extract once to natural owner (manager method, base class hook) — not a new util package

## Testing (no Bukkit in unit tests)

Friction during rip = missing seam:

- Extract pure logic behind manager/repository method
- Inject dependencies instead of `CivGlobal` / static init in tests
- See [tdd/tests.md](../tdd/tests.md)

Do not add `@Disabled` Bukkit tests to "characterize" — extract a testable seam first.

## Admin tooling

If rip changes persistence or progression shape, evaluate `/ad` commands (`admin-commands-for-features.mdc`). Ask once if unclear; implement minimal force/reset/info when state is hard to exercise otherwise.

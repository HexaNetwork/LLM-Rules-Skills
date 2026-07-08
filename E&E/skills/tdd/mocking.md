# When to Mock

In CivCraft, **mock aggressively**. Bukkit types (`Town`, `ItemStack`, `Inventory`, `Player`, etc.) are Mockito stubs in unit tests — not real server objects. The goal is to test the **real public interface** of the class under test, not to retreat to a smaller helper or static method.

Authoritative rules: `java-unit-tests-no-bukkit.mdc`, `java-unit-tests-itemstack.mdc`.

## Default approach

1. **Test the public interface** of the class under test.
2. **Mock every Bukkit collaborator** the code path touches — stub only what the SUT calls.
3. **Inject dependencies** in production when a type cannot be constructed or mocked cleanly (e.g. `ItemStackFactory`, `CottageFoodCatalog`, repositories).
4. **Skip the test** only when mocking truly cannot reach the behavior. Note the gap in the PR. No `@Disabled`, flaky, or bootstrapped tests.

Do **not** drop to a shallower test target (static helper, pure function extracted solely for testability) when the public interface can be reached with more mocks.

## Recognize init failures — mock more, don't bootstrap

Stop and change approach when you see:

- `ExceptionInInitializerError` / `NoClassDefFoundError` on `CivSettings`, `CivCraft`, or `org.bukkit.Bukkit`
- Errors about missing plugin, scheduler, or server
- `@BeforeAll` that assigns `CivSettings.*` or `mockStatic(Bukkit.class)` to boot the test class

These mean a dependency is **unmocked**, not that you need a server. Find what the SUT constructs or reads statically and mock or inject it.

## Do not add

- `@BeforeAll` Bukkit/CivSettings bootstraps (partial mocks, field assignment on `CivSettings`)
- `@Disabled("Requires Bukkit…")` skeleton tests — **delete** them
- `mockStatic(Bukkit.class)` or MockBukkit / embedded server
- Tests that touch `CivGlobal` static fields unless init is already proven safe
- `new ItemStack(...)` or `Material.matchMaterial` to build test data
- `MockedConstruction<ItemStack>` — mock `ItemStackFactory` instead

## Mockito patterns

### Town and domain objects

Stub only what the SUT calls:

```java
Town town = mock(Town.class);
when(town.getId()).thenReturn("test-town");
```

### ItemStack

Production code creates stacks through injectable `ItemStackFactory`, not `new ItemStack(material)`:

```java
ItemStack stack = mock(ItemStack.class);
when(stack.getType()).thenReturn(Material.IRON_INGOT);
when(stack.getAmount()).thenReturn(5);

ItemStackFactory factory = mock(ItemStackFactory.class);
when(factory.create(Material.COAL)).thenReturn(coalStack);
```

When the SUT calls `setAmount`, wire `getAmount` to follow:

```java
doAnswer(inv -> {
    when(stack.getAmount()).thenReturn(inv.getArgument(0));
    return null;
}).when(stack).setAmount(anyInt());
```

Custom items: mock `ILoreItem` (or the registry interface) — never reach for static `LoreItemRegistry` in new testable code.

### Inventory

Mock `Inventory`, return `new ItemStack[]{ stack }` from `getContents()` / `getStorageContents()` — slots hold mocks, not real stacks.

### Injected catalogs and services

When construction pulls `CivSettings`, inject the dependency instead:

```java
CottageFoodCatalog catalog = mock(CottageFoodCatalog.class);
StructureQuestGenerator generator = new StructureQuestGenerator(catalog);
```

### Filters and similarity

Stub `getType`, `getAmount`, `isSimilar`, `serializeAsBytes`, `asOne` as required. Use `InOrder` when the SUT temporarily mutates amount then restores it.

## When to skip

Skip only after you have:

- Mocked every Bukkit type on the code path
- Injected every static/global dependency the SUT reads
- Confirmed the behavior requires a live server (scheduler ticks, world mutations, plugin lifecycle)

Note in the PR: `untested: requires Bukkit server — <reason>`. **No** failing, flaky, or `@Disabled` test left behind.

## Examples that work today

- `CottageStructureQuestGeneratorTest` — injects `CottageFoodCatalog`, tests `StructureQuestGenerator` directly
- `FieldWindmillHarvestServiceTest` — `mock(Town.class)` with only `getId()` when town state is never touched
- `ContainsInStorageTest` — mocked `Inventory` with mocked stacks in slots

# YAGNI / KISS review lens

**Question:** Does this branch build only what is needed today, in the simplest shape that fits existing CivCraft patterns?

## Read first

- `.cursor/rules/prefer-few-service-classes.mdc`
- `.cursor/rules/java-civsettings-config-access.mdc`
- `.cursor/rules/java-no-adhoc-sql-loaders.mdc`
- `.cursor/rules/admin-commands-for-features.mdc` (only if admin tooling was added without need)

## Flag

| Signal | Examples |
|--------|----------|
| **Scope creep** | Large diffs unrelated to the stated feature (config, quests, refactors in other packages) |
| **Speculative generality** | Config knobs, lookahead buffers, or abstractions with no current caller |
| **Test-only production types** | Classes wired in module/DI but never called from gameplay paths |
| **Parallel implementation** | Second code path doing the same job as an existing owner |
| **Thin wrappers** | One-line static forwards, `*Helper` / `*Resources` with one call site |
| **Over-factored packages** | Many public types for a single entry point today |
| **Premature interfaces** | Interface + adapter existing only to mock one concrete type in tests |
| **Persist-before-need** | Writing derived or preview state when derive-at-read suffices |
| **YAML / config ceremony** | Boilerplate blocks required for the common case |

## Positive signals (Keep as-is)

- Derive-at-read instead of persist-at-roll
- Deletion of legacy / dead types
- Focused factories with one clear job
- Thin UI windows delegating to a natural owner
- Config extraction that slims an existing god type (not a new wrapper layer)

## Severity guide

| Level | When |
|-------|------|
| **High** | Unrelated scope, dead production stack, or misleading wiring (registered but bypassed) |
| **Medium** | Extra types/indirection with no second consumer; config defaults that do unnecessary work |
| **Low** | Defer-until-third-consumer extraction; visibility widened only for tests |

## Output template

Return markdown in this shape:

```markdown
## YAGNI / KISS review

**Verdict:** Approve | Approve with nits | Request changes

### Findings

For each finding:

| | |
|---|---|
| **Severity** | High / Medium / Low |
| **Problem** | One sentence |
| **Action** | Concrete fix (delete, merge, split PR, default config, wire or drop) |
| **Files** | Primary paths |

### Keep as-is

| Item | Notes |
|------|-------|
| ... | Why this earns its place |

### Summary

2–3 sentences: main blockers, main wins, recommended next step.
```

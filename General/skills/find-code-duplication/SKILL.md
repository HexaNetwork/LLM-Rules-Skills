---
name: find-code-duplication
description: >-
  Scans the codebase for duplicated logic, near-duplicate components, and
  repeated patterns (similar functions, hooks, services, UI). Use when the user
  asks to find duplication, DRY violations, copy-paste, similar components, or
  consolidate repeated code. Consolidation requires TDD characterization tests
  before refactor (follows the tdd skill).
disable-model-invocation: true
---

# Find Code Duplication

Find **copy-paste and near-duplicate** code — not architectural shallowness (use `improve-codebase-architecture` for that).

## Scope first

Confirm with the user (or infer from the request):

| Input | Default |
|-------|---------|
| Paths | `src/` |
| Extensions | `.ts`, `.tsx` |
| Min clone size | 8 lines / 50 tokens (jscpd defaults below) |
| Include tests | `src/**/*.test.*` yes; `tests/e2e/` only if asked |

Record scope in the report header.

## Workflow

Copy this checklist and tick as you go:

```
- [ ] 1. Mechanical clone scan (jscpd)
- [ ] 2. Pattern grep (known duplication signatures)
- [ ] 3. Semantic pass (features, hooks, components)
- [ ] 4. Triage & dedupe findings
- [ ] 5. Report (template below)
- [ ] 6. Consolidation — only if user picks clusters; TDD first (see below)
```

Do **not** refactor during the scan (steps 1–5). Consolidation is step 6 only, after the user picks clusters.

---

### 1. Mechanical clone scan

Run from repo root (no install — uses `npx`):

```bash
npx --yes jscpd src --min-lines 8 --min-tokens 50 --format typescript --reporters console --ignore "**/*.test.ts,**/*.test.tsx,**/node_modules/**"
```

Optional JSON for large repos:

```bash
npx --yes jscpd src --min-lines 8 --min-tokens 50 --format typescript --reporters json --output .jscpd-report --ignore "**/*.test.ts,**/*.test.tsx,**/node_modules/**"
```

Then read `.jscpd-report/jscpd-report.json` if created; delete `.jscpd-report/` when done (add to `.gitignore` if the folder keeps reappearing).

**Narrow scope** when the user named a feature:

```bash
npx --yes jscpd src/features/landing-designer --min-lines 6 --min-tokens 40 --format typescript --reporters console
```

Treat jscpd hits as **candidates** — verify in source before reporting.

---

### 2. Pattern grep

Run targeted searches from [PATTERNS.md](PATTERNS.md). Prioritise:

- `src/lib/http/**` vs `src/**/services/**` (API helpers)
- Repeated `URLSearchParams`, pagination, envelope unwrap, `Map<string, Promise`
- Parallel component names (`*Modal`, `*Picker`, `*Panel`, `*Form`)

Also read `.cursor/rules/api-service-deduplication.mdc` — duplicated findings there are **high priority**.

---

### 3. Semantic pass

Use `subagent_type=Explore` (thoroughness: **medium** unless full-repo scan → **very thorough**). Launch **parallel** agents when scope spans multiple feature folders.

Each explorer should return:

- File pairs or groups with **same responsibility**
- What differs (names, types, one branch)
- Suggested consolidation target (`src/lib/...`, shared hook, Kitchen Sink demo)

**UI:** Before proposing a new shared component, search `UI_CATALOG_ENTRIES` in `src/features/dev/uiCatalog/index.ts` and the matching `uiCatalog/demos/*SectionDemo.tsx` for an existing pattern.

**HTTP:** Do not merge mappers that model **different OpenAPI shapes** — see `docs/DESIGN.md` (single-contract policy). Similar-looking parsers for different resources stay separate; extract only true shared wire mechanics.

---

### 4. Triage

Merge mechanical + grep + semantic results. Drop or downgrade:

| Signal | Action |
|--------|--------|
| Identical test arrange/act boilerplate | Note as low priority unless 5+ copies |
| Same import block / type-only similarity | Ignore |
| Legitimate symmetry (left/right panel mirrors) | Tag **intentional** |
| Different domain concepts, similar shape | Tag **coincidental** — do not merge |
| Same bug-prone logic in 2+ services | Tag **extract** — high priority |

Rank remaining items: **high** (same logic, drift risk), **medium** (structure overlap), **low** (cosmetic).

---

### 5. Report

Use [REPORT-TEMPLATE.md](REPORT-TEMPLATE.md). End with:

> Which clusters should we consolidate? (numbers or "none")

Do **not** start refactors until the user picks clusters.

---

### 6. Consolidation (TDD required)

When the user asks to fix one or more clusters, **read and follow the `tdd` skill** for the entire consolidation. **Never refactor duplicated code without tests first.**

#### Characterization before extract

For each cluster, before moving or merging implementation:

1. **Identify the public surface** — exported function, hook return value, component behaviour, or HTTP helper contract callers rely on.
2. **RED** — Add or extend tests that lock **current behaviour** from **every** duplicate site (same inputs → same outputs/errors). If only one copy has tests today, port or duplicate assertions so all paths are covered **before** deletion.
3. **GREEN** — Run `npm run test:run` (scoped to affected files); all characterization tests must pass on unchanged code.
4. **REFACTOR** — Extract shared code; delete duplicates; keep tests green. One **vertical** RED→GREEN→REFACTOR slice per behaviour — do not batch-write all tests then all refactors (see `tdd` skill anti-pattern).
5. **Verify** — `npm run test:run` for the slice; `npm run build` when the task is done.

If a cluster has no testable surface (e.g. pure markup duplication), confirm with the user: add a minimal behaviour test (render/query) or skip consolidation.

#### Refactor rules (unchanged)

- Do not merge mappers for different OpenAPI shapes.
- Search `UI_CATALOG_ENTRIES` and section demos before introducing shared UI.
- Prefer extracting to `src/lib/` or an existing helper over a new abstraction.

---

## Relationship to other skills

| Skill | Use when |
|-------|----------|
| `find-code-duplication` | Copy-paste, clones, repeated helpers/components |
| `tdd` | **Always** when consolidating clusters — tests before refactor |
| `improve-codebase-architecture` | Shallow modules, seams, depth, testability of design |
| `api-service-deduplication` rule | Already lists API-layer patterns to search first |

## Additional resources

- Grep seeds and false-positive rules: [PATTERNS.md](PATTERNS.md)
- Report format: [REPORT-TEMPLATE.md](REPORT-TEMPLATE.md)

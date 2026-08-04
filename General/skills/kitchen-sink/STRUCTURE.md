# Kitchen sink structure

Stack-agnostic layout for a **visual playground**. Adapt paths and file
extensions to the host language/toolkit. Defaults below use a generic
`kitchen-sink/` (or `uiCatalog/`) tree.

## Directory layout

```
kitchen-sink/                         # or src/.../uiCatalog/ when embedded
├── KitchenSinkShell.<ext>            # Side panel + scroll/jump + section host
├── catalog.<ext|json|yaml>           # Ordered sections (data only — no demo imports)
├── types / schema                    # Entry + section shape (see below)
├── CatalogSectionHeading.<ext>       # "NN — Title" from catalog order
├── validateCatalog.<ext>             # Anchor extraction / invariant helpers
├── sections/                         # One metadata module (or file) per section
│   ├── typography.*
│   ├── colors.*
│   ├── buttons.*
│   └── …
└── demos/                            # One demo module per section
    ├── TypographySectionDemo.*
    ├── ColorsSectionDemo.*
    └── …
```

Optional: `data/` for demo fixtures only. Keep fixtures out of shipping feature
code when possible.

**Embedded variant:** place the same tree under a DEV/debug feature folder and
mount from a debug menu or gated route — structure stays the same.

## Catalog schema

Language-neutral fields (express as types, structs, JSON Schema, or YAML):

```
UiCatalogEntry:
  id            string   # stable id, e.g. button-variants
  sectionId     string
  title         string
  importPath    string   # where agents import the primitive
  exportName    string   # symbol / type / prefab / class name
  whenToUse     string
  summary       string
  sinkAnchor    string   # stable id in the demo tree (DOM id, a11y id, node name, …)
  variants?     string[]
  tokens?       string[]
  seeAlso?      string[]
  doNotUse?     string
  e2eSurfaceId? string

UiCatalogSection:
  id            string
  title         string   # short sidebar label
  demoFileBase  string   # matches demo module/export by convention
  entries       UiCatalogEntry[]

KitchenSinkSidebarNavItem:
  target        string   # section id or jump target
  label         string
```

## Catalog aggregator

- Load every section definition from `sections/`.
- Export `UI_CATALOG_SECTIONS` (or `CatalogSections`) in **sidebar/display order**.
- Derive:
  - flat `UI_CATALOG_ENTRIES`
  - sidebar nav from section order
  - `getSectionOrdinalLabel(sectionId)` → `"01 — Type"`
- **Do not** import demo UI from the catalog module (avoids cycles).

## Demo registry

Map `section.id → demo` by convention (`demoFileBase`) or an explicit registry.
Any language is fine; keep the public shape: given a section id, render its demo.

## Playground shell

Requirements (all hosts):

1. **Fixed/persistent side panel** with title + nav from catalog section order.
2. **Jump-to-section** on nav activate (scroll, list selection, camera focus — whatever fits).
3. **Active section** tracking while browsing (intersection, scroll position, or selection).
4. **Main canvas** rendering section demos in catalog order with clear spacing.
5. **Footer or header** marking this as a non-shipping playground.
6. Optional local feedback (toasts) scoped to the playground — don’t force product notification systems.

Sidebar: muted default, accent + subtle highlight when current, clear hover/focus.

### Host recipes (pick one)

| Stack family | Typical host |
| --- | --- |
| Web (any framework) | Stand-alone mini-app, or DEV-only route/screen |
| Desktop (Qt, WPF, SwiftUI, Electron, Tauri) | Debug window / internal menu item |
| Mobile | Debug build screen / shake menu / deep link |
| Game engines | Dedicated scene/level, editor play mode only |
| Tokens/CSS-only | Static page that still renders live controls where possible |
| Non-GUI libraries | Companion viewer that shows tokens + any renderable widgets; skip control sections that cannot exist |

## Section demo conventions

- Root of the demo is addressable as `section.id`.
- Every `entry.sinkAnchor` is addressable in that demo (id attribute, accessibility identifier, named node, tagged GameObject, etc.).
- Small muted captions above example clusters (`Variants`, `Sizes`, …).
- Use **real** shared primitives from the project — not redrawn mockups.
- Sentence case for labels unless the product uses a different casing rule.

Pseudocode:

```
SectionDemo(typography):
  root.id = "typography"
  heading = ordinalLabel("typography")
  block.id = "typography-heading-scale"
    … live heading scale …
```

## Invariant checks

Assert at minimum:

1. Child `entry.id` unique across the catalog.
2. Every `entry.sectionId` exists on a section.
3. `sinkAnchor` unique within each section.
4. Every section has a registered demo.
5. Demo declares the section root id.
6. Demo declares every child `sinkAnchor`.

Implementation may parse source, walk a scene tree, or query the live playground — pick what the stack can automate.

## How to open it

Document one command or gesture, for example:

- `npm run kitchen-sink` / `./gradlew kitchenSink` / editor menu **Debug → Kitchen Sink**
- Development build only: debug menu entry
- Scene name / route / deep link reserved for internal use

Never register it as a normal end-user destination.

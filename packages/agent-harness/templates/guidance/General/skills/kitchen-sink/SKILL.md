---
name: kitchen-sink
description: >-
  Create or maintain a kitchen-sink visual playground — a stand-alone UI
  reference with side-panel navigation, numbered sections, and live examples of
  typography, color tokens, controls, and shared components. Use when the user
  asks for a kitchen sink, UI catalog, design system gallery, styleguide,
  visual playground, token swatches, or a DEV-only design sandbox for agents
  and human reviewers — in web apps, native/desktop clients, games, or a
  separate playground host.
disable-model-invocation: true
---

# Kitchen Sink

Build (or extend) a **kitchen sink**: a visual playground that is the contract
for typography, tokens, and shared UI. Agents read catalog metadata; humans
browse live examples. Prefer a **stand-alone playground host** that imports the
project’s real UI primitives. Embed inside a product (DEV-only screen / debug
menu) only when that is clearly easier for the stack.

Works for any UI surface: web, desktop, mobile, game HUD, editor plugin, etc.
The playground must *show* real shared widgets — not screenshots of them —
using whatever toolkit the project already uses.

## Modes

| Mode | When | Outcome |
| --- | --- | --- |
| **Bootstrap** | No kitchen sink exists | Scaffold catalog + playground shell + baseline sections |
| **Extend** | Shared UI was added/changed | Add/update section metadata + demo anchors |
| **Reference** | Designing or reviewing UI | Open playground / cite `sinkAnchor`s; match existing variants |

Ask which mode if unclear. Default to **Extend** when a catalog already exists,
**Bootstrap** when it does not.

## Non-negotiables

1. **Visual playground** — one browsable surface with live examples (not a PDF, not docs-only).
2. **One catalog, two consumers** — structured metadata for LLMs/tests; demos for eyes.
3. **Side-panel navigation** derived from section order (jump to section).
4. **Numbered section headings** (`01 — Type`) derived from the same order.
5. **Every child row has a matching demo anchor** (`sinkAnchor` ↔ stable id in the demo tree).
6. **Dev / non-shipping** — never part of the product’s primary navigation or release UX.
7. **Tokens before raw values** — swatches and demos use named design tokens when they exist.
8. **Reuse before invent** — search catalog entries before new shared primitives.

## Choose a host

Pick the lightest host that can render the project’s real UI:

| Host | Use when |
| --- | --- |
| **Separate playground app/window/scene** | Default for most stacks (web mini-app, desktop debug window, Unity/Godot scene, editor tool) |
| **In-product DEV screen** | App already has routing or a debug menu and can gate it to development builds |
| **Docs site / static HTML** | UI is CSS/HTML-first or tokens-only; still render live controls if possible |

Do **not** require a web router. A Minecraft/Java, Qt, SwiftUI, or game project gets a playground in *its* UI stack (or a small companion viewer that can display the same assets/tokens).

## Bootstrap workflow

Copy and track:

```
Kitchen sink bootstrap:
- [ ] 1. Locate tokens + shared UI roots
- [ ] 2. Pick playground host (stand-alone preferred)
- [ ] 3. Scaffold catalog + shell (sidebar + sections)
- [ ] 4. Add baseline sections (see SECTIONS.md)
- [ ] 5. Wire DEV-only / non-shipping entry point
- [ ] 6. Add catalog invariant checks
- [ ] 7. Smoke-check: navigate every section, verify examples
```

### 1. Locate sources of truth

Find (or create):

- Design tokens / theme (colors, type, spacing, radius)
- Shared UI primitives (buttons, fields, dialogs, …)
- How development-only surfaces are gated in this stack

If tokens are missing, create a minimal token set (bg/text/accent/error, spacing, radius, type scale) and demo those in Color + Type first.

### 2–3. Scaffold

Follow [STRUCTURE.md](STRUCTURE.md). Keep **catalog data** free of demo UI imports (demos may read catalog helpers; catalog must not import demos).

### 4. Baseline sections

Implement the **required baseline** in [SECTIONS.md](SECTIONS.md) before product-specific sections. Skip a baseline row only when the toolkit has no such primitive — otherwise add primitive + demo together.

### 5. Entry point

- Gate behind development / debug / internal flags for the platform.
- Provide a documented way to open the playground (script, menu item, deep link, scene name).
- Hide product chrome that fights the playground when embedded.

### 6–7. Invariants + smoke-check

See STRUCTURE.md. Confirm side-nav jumps, active section tracking, and Color + Type + primary controls render without errors.

## Extend workflow

When adding or changing shared UI:

1. Search catalog entries (and matching demos) for an existing pattern.
2. Prefer extending variants/props on the catalogued component over a parallel one-off.
3. Update section metadata (`whenToUse`, `summary`, `variants`, `tokens`, `doNotUse`).
4. Update the section demo: visible example + matching `sinkAnchor`.
5. Register a new section only for a new *family*, not a new variant.
6. Run catalog invariant checks.

## Reference workflow (design / review)

1. Open the playground.
2. Cite `sectionId` + `sinkAnchor` (and `variants` / `tokens` when relevant) in plans and reviews.
3. Match catalogued variants; do not invent parallel styles for the same job.
4. Mark one-offs explicitly (`doNotUse` / “one-off exception”) so agents do not copy them.

## Anti-patterns

- Dumping every screen into the sink (catalog **shared** patterns, not full features).
- Metadata without a live demo, or demos without metadata rows.
- Hardcoded brand colors when a token exists.
- Shipping the playground as product UX.
- Assuming React/DOM — adapt shell and anchors to the host UI toolkit.
- Giant single-file demos — keep one demo module per section.

## Additional resources

- [STRUCTURE.md](STRUCTURE.md) — layout, catalog shape, shell, hosts, checks
- [SECTIONS.md](SECTIONS.md) — baseline sections, entry schema, demo conventions

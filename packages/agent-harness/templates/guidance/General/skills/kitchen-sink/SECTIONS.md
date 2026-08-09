# Kitchen sink sections

## Entry metadata (every child row)

| Field | Required | Purpose |
| --- | --- | --- |
| `id` | yes | Stable catalog id (`button-variants`) |
| `sectionId` | yes | Parent section id |
| `title` | yes | Human label |
| `importPath` | yes | Where agents import/load the primitive |
| `exportName` | yes | Symbol, type, prefab, class, or asset name |
| `whenToUse` | yes | Decision guidance for agents |
| `summary` | yes | What the demo shows |
| `sinkAnchor` | yes | Stable id in the demo tree |
| `variants` | no | Enumerated variant/size values |
| `tokens` | no | Design token names exercised |
| `seeAlso` | no | Related paths or entry ids |
| `doNotUse` | no | Explicit ban / one-off warning |
| `e2eSurfaceId` | no | Stable hook for automated checks |

Write `whenToUse` and `doNotUse` for agents — short, imperative, no fluff.

## Required baseline (bootstrap these first)

Order matters: Type → Color → Controls → Feedback → Overlays → Layout.

Map names to the host toolkit (Button → `JButton` / `UIButton` / prefab / etc.).

| # | `id` | Title | Must show |
| --- | --- | --- | --- |
| 01 | `typography` | Type | Heading scale, body scale, semantic styles (weights, emphasis); selection/highlight tokens if defined |
| 02 | `colors` | Color | Design-token swatches (token name + value); optional extended palette |
| 03 | `buttons` | Buttons | All variants, sizes, icon-only (+ accessible name), disabled/busy, groups if present |
| 04 | `inputs` | Inputs | Text field, multiline, search, select, toggle/checkbox, validation/error, field help |
| 05 | `badges` | Badges | Status / count / tag chips used as shared primitives |
| 06 | `icons` | Icons | Shared icon set at default sizes; how to load (no ad-hoc one-off pipelines) |
| 07 | `alert` | Alert | Inline alert / banner severity levels |
| 08 | `toasts` | Toasts | Triggerable toast/snackbar variants (success/error/info) |
| 09 | `modal` | Modal | Dialog sizes/presets, confirm pattern; focus/input-lock notes in metadata |
| 10 | `containers` | Containers | Surface panels, bordered sections, shared layout shells |

Skip a baseline row only when the host truly has no such primitive — do not fake a Button demo if there is no shared Button yet; add the primitive + demo together.

If the project is tokens-only (no widget kit), ship Type + Color (+ Containers if layout tokens exist) and stop until controls exist.

## Common product extensions

Add after baseline when the product has the pattern:

- Cards / media cards
- Tables / lists
- Stats / metric tiles
- Tag list / tag picker
- Collapsibles / accordions
- Segmented toggles (if not under Buttons)
- Domain composites — only when reused across screens

Domain composites belong in the catalog when they are **shared building blocks**. Feature-only screens do not.

## Demo content rules

1. **Live widgets** — instantiate real shared UI; avoid static screenshots as the only evidence.
2. **All public variants** — if a control has six variants, show six.
3. **States** — default, pressed/hover (document if style-only), selected, disabled, loading/error where applicable.
4. **Accessibility** — icon-only controls need an accessible name in the demo.
5. **Tokens** — Color section labels use token names, not only raw hex/RGB.
6. **One-offs** — mark with `doNotUse` / “one-off exception” and keep visually secondary.
7. **Labels** — muted caption above each example cluster; sentence case by default.

## Section metadata sketch

```yaml
id: buttons
title: Buttons
demoFileBase: ButtonsSectionDemo
entries:
  - id: button-variants
    sectionId: buttons
    title: Button variants
    importPath: shared/ui/Button   # adapt to project
    exportName: Button
    whenToUse: Primary, secondary, surface, ghost, and danger actions.
    summary: All Button variant values in one row.
    sinkAnchor: button-variants
    variants: [primary, secondary, surface, ghost, danger]
```

Equivalent structs/types/JSON are fine — keep the same fields.

## Sidebar titles

Keep sidebar labels short (`Type`, `Color`, `Buttons`). Long titles wrap poorly in a narrow rail.

## What not to catalog

- Entire feature screens or flows
- One-off experiments with no reuse
- Deprecated components (remove demos; don’t keep zombies)
- External styleguide embeds as a substitute for the project’s own tokens/components

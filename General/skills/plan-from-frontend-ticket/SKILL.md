---
name: plan-from-frontend-ticket
description: >-
  Draft a transient FE implementation plan from an approved contract, frontend
  issue, OpenAPI, and codebase. Use at /implement stage 1 after frontend-preflight
  passes, or when the user asks for an FE implementation plan.
---

# Plan from frontend ticket

Produces a **transient** implementation plan for **grill-me**. The PRD (`to-prd`) replaces this artifact; **delete** the plan file after PRD approval.

## Prerequisites

- `frontend-preflight` **PASS** (or documented E-only).
- Read `docs/DESIGN.md` for routing, features, HTTP policy, and UI catalog (`UI_CATALOG_ENTRIES` in `src/features/dev/uiCatalog/index.ts`).

## Inputs

| Input | Use |
|-------|-----|
| `docs/contracts/{slug}.md` | API/UI contract (full-stack handoff) |
| Frontend GitHub issue `#N` | Acceptance hints, links, scope |
| Closed backend issue | Context only (B+E); do not replan backend |
| Published OpenAPI | Wire shapes for API sections |
| Codebase | Existing modules, patterns, tests to extend |

## Process

1. **Explore** relevant `src/features/*`, `src/appShell/AppShellRoutes.tsx`, `src/i18n/`, and `features/*/services/*` for the area touched.
2. **Draft** `docs/plans/{slug}-fe-plan.md` using the template below.
3. **Do not** duplicate the PRD’s user-story list in full — focus on **how** the frontend implements the contract.
4. Tell the user to run **grill-me** on this plan (or continue `/implement` stage 2).

## Template — `docs/plans/{slug}-fe-plan.md`

```markdown
# FE implementation plan: {title}

**Status:** Draft — for grill-me only (delete after PRD approved)
**Slug:** {slug}
**GitHub Issue (FE parent):** {url or #N}
**Contract:** docs/contracts/{slug}.md
**Backend issue:** #{n} (closed) | **None (FE-only)**
**OpenAPI:** verified {date or note}

## Scope summary

{2–4 sentences: what ships in the browser}

## Routes and shell

- Paths to add/change in `AppShellRoutes` / `appPaths` public vs protected
- Lazy imports / overlays if any

## Feature modules

| Module | Change |
|--------|--------|
| `features/...` | {new hook, service, screen, etc.} |

## HTTP / API seam

- Endpoints (method + path) from OpenAPI
- Target service module(s); mapper inputs/outputs (field names from spec only)
- Error handling (`docs/error-codes.md` if applicable)

## UI and UX

- UI catalog entries to reuse (`UI_CATALOG_ENTRIES`; cite `sinkAnchor` / section id when relevant)
- Modals, loading, empty states
- i18n: key namespaces to add (no inline English)

## Testing

- Vitest/MSW: which behaviors at which boundary
- Fixtures under `tests/fixtures/openapi/` if wire shapes change

## Out of scope

{explicit exclusions}

## Open questions

{numbered list for grill-me}
```

## Rules

- **Single-contract:** no dual parsers for OpenAPI drift; one mapper path per endpoint.
- **No** long-lived file paths in user-story form — modules table is enough.
- Align with the **contract**; if contract and OpenAPI disagree, **flag** and stop for human resolution.
- Plan is **input to grill-me and to-prd**, not the implementation spec after PRD exists.

## After PRD approval

Delete `docs/plans/{slug}-fe-plan.md`. Do not update the plan file post-PRD.

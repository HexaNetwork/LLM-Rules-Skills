---
name: frontend-preflight
description: >-
  Verify a frontend slice is ready to implement: closed backend issue plus
  OpenAPI (B+E), or FE-only with no backend blocker. Use at the start of
  /implement or when the user asks "is this ready to implement".
---

# Frontend preflight

Run at the **start** of `/implement` before drafting `docs/plans/{slug}-fe-plan.md`.

## Inputs (resolve in order)

1. **Frontend parent issue** `#N` or URL (preferred after full-stack handoff).
2. **`docs/contracts/{slug}.md`** linked from the issue or named by the user.
3. **FE-only:** user declares no backend dependency, or issue/contract explicitly states FE-only.

Derive `{slug}` from the contract filename, issue title, or user-provided slug (kebab-case).

## Mode detection

| Mode | When |
|------|------|
| **B+E** (default) | Contract or parent issue references a **backend** issue and HTTP API work |
| **E-only** | No backend issue; UI/i18n/routing-only; user says FE-only |

For **E-only**, set `**Backend:** None (FE-only)` in the eventual plan header and **skip** backend checks below.

## B+E checks (must all pass)

1. **Contract present** — `docs/contracts/{slug}.md` exists, or the frontend issue body contains an equivalent contract section with API/UI expectations.
2. **Backend issue closed** — Read the linked backend issue (sub-issue or referenced `#N`). State must be **closed**. If only a URL is given, use GitHub MCP `issue_read` (`method`: `get`) per `github-mcp` skill.
3. **OpenAPI alignment** — Fetch published OpenAPI (`docs/DESIGN.md` URL). Confirm every **method + path** the contract relies on is documented with expected request/response shapes. Note schema names for the plan; do not invent fields missing from the spec.
4. **Frontend parent issue** — If implementing from a parent FE issue, confirm it links to the contract and (when applicable) the closed backend issue.

**On failure:** Stop. Report which check failed and what the user must do (reopen backend, wait for deploy, update contract, fix OpenAPI drift). Do **not** draft a plan or run grill-me.

## E-only checks

1. Confirm scope has **no** required backend delta (no new endpoints the UI depends on).
2. If the slice still **calls existing** APIs, spot-check those paths in OpenAPI (optional but recommended).
3. Record `**Backend:** None (FE-only)` for the plan stage.

## Output

Reply with a short **Preflight report**:

```
Preflight: {PASS | FAIL}
Slug: {slug}
Mode: {B+E | E-only}
Contract: docs/contracts/{slug}.md (or "issue body")
Backend issue: #{n} closed={yes|no|n/a}
OpenAPI: {paths verified list or failure detail}
FE parent issue: #{n} (if any)
Ready for: plan-from-frontend-ticket
```

**Gate:** `/implement` continues only on **PASS** or explicit user override (discourage overrides for B+E failures).

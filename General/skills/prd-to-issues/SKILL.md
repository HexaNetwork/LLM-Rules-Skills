---
name: prd-to-issues
description: >-
  Converts a Product Requirements Document (PRD) or structured spec into
  independently-grabbable tracker issues using tracer-bullet vertical slices.
  Use when the user wants PRD → issues, tracker tickets from a PRD, or
  /prd-to-issues.
---

# PRD to Issues

Break a PRD (or equivalent spec with goals, scope, user stories, and acceptance ideas) into independently-grabbable issues using vertical slices (tracer bullets).

The issue tracker and triage label vocabulary should have been provided to you.

## Tracker labels

On every published slice issue (`issue_write` `create`), set `labels` to include **`needs-triage`** plus the correct scope label(s) (repo: **TheHexaForge/TaleTailorBackend**).

| Label | Apply when |
|-------|------------|
| `frontend` | This slice’s acceptance criteria are delivered mainly in **Storytailor-Frontend** (UI, routing, i18n, client services/hooks, FE tests). Default for slices cut from a frontend-only PRD or `/implement`. |
| `backend` | This slice’s acceptance criteria are delivered mainly in **TaleTailorBackend** (API, schema/migrations, server logic, OpenAPI). |
| `frontend` + `backend` | The **same issue** has substantial, verifiable deliverables in **both** repos (e.g. new endpoint and UI ship together in one slice). If one side is only a blocker, use a single label for what **this** issue implements and put the other work under **Blocked by**. |

Classify each slice from its **What to build** and **Acceptance criteria**, not from the parent PRD label alone. A parent labeled `frontend` can still spawn a `backend` slice if the breakdown adds server work; conversely, split full-stack PRDs into FE-only and BE-only slices when dependencies allow.

## Process

### 1. Gather context

Treat the PRD as the source of truth:

- Prefer the PRD attached in the conversation, a repo path (for example `issues/prd.md`), or a tracker issue whose body holds the PRD. If given a tracker reference or path, fetch or read its full body and linked comments.

- Supplement with surrounding conversation context (constraints, exclusions, glossary).

Use the PRD’s user stories, requirements, non-goals, and acceptance cues when naming slices and mapping coverage in step 4.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Issue titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

### 3. Draft vertical slices

Break the plan into **tracer bullet** issues. Each issue is a thin vertical slice that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

Slices may be 'HITL' or 'AFK'. HITL slices require human interaction, such as an architectural decision or a design review. AFK slices can be implemented and merged without human interaction. Prefer AFK over HITL where possible.

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones
</vertical-slice-rules>

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show:

- **Title**: short descriptive name
- **Type**: HITL / AFK
- **Layer**: `frontend` | `backend` | `full-stack` (both labels on publish)
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories this addresses (if the source material has them)

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are the correct slices marked as HITL and AFK?
- Is **Layer** correct for each slice (and for filtering the tracker)?

Iterate until the user approves the breakdown.

### 5. Publish the issues to the issue tracker

For each approved slice, publish a new issue via GitHub MCP `issue_write` (`method`: `create`) per `github-mcp`. Use the issue body template below.

Set `labels` on create:

- Always: `needs-triage`
- Plus: `frontend`, `backend`, or both — map from the approved **Layer** (`full-stack` → `frontend` and `backend`)

Publish issues in dependency order (blockers first) so you can reference real issue identifiers in the "Blocked by" field.

When the slice set came from an existing tracker PRD/parent issue, include that reference under **Parent** in each published issue body.

**Bind slices as sub-issues of the PRD** when publishing from a tracker PRD/parent issue (not for local-only PRDs with no parent issue):

1. Resolve the parent PRD issue number and `owner`/`repo` before creating children.
2. After each `issue_write` `create`, read the new issue with `issue_read` (`method`: `get`) and take its numeric **`id`** from the response (this is the GitHub issue ID, not the issue number).
3. Link the child to the parent with `sub_issue_write`: `method`: `add`, `issue_number` = parent PRD number, `sub_issue_id` = child issue `id`. Use the same `owner`/`repo` as the parent.
4. When publishing multiple slices, `reprioritize` via `sub_issue_write` only if the user asked for a specific sub-issue order; otherwise default GitHub ordering is fine.
5. After all slices are linked, verify with `issue_read` (`method`: `get_sub_issues`) on the parent and report the parent URL plus each child issue number in the summary.

<issue-template>
## Parent

A reference to the parent PRD or parent issue on the issue tracker (if one exists — e.g. the PRD epic or planning issue — otherwise omit this section).

## Layer

`frontend` | `backend` | `full-stack` — which repo(s) own this slice’s deliverables (must match the issue’s `frontend` / `backend` labels).

## What to build

A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

- A reference to the blocking ticket (if any)

Or "None - can start immediately" if no blockers.

</issue-template>

Do NOT close or modify any parent issue.

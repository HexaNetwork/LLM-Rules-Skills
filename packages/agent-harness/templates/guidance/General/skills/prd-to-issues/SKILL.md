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

Use the issue tracker, repository ownership model, and labels supplied by the user or project configuration. Never assume a particular organization, repository, frontend/backend split, or triage label. Classify each slice from its acceptance criteria and use only established project labels.

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
- **Ownership**: repository, package, or bounded context responsible for the slice
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories this addresses (if the source material has them)

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are the correct slices marked as HITL and AFK?
- Is **Ownership** correct for each slice?

Iterate until the user approves the breakdown.

### 5. Publish the issues to the issue tracker

For each approved slice, publish a new issue through the configured tracker integration. Use the issue body template below and apply only labels from the project's established vocabulary. If no tracker integration is available, stop before mutation and return the approved issue bodies ready to publish.

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

## Ownership

The repository, package, team, or bounded context that owns this slice's deliverables.

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

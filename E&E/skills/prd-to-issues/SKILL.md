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

The issue tracker and triage label vocabulary should have been provided to you — run `/setup-matt-pocock-skills` if not.

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
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories this addresses (if the source material has them)

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are the correct slices marked as HITL and AFK?

Iterate until the user approves the breakdown.

### 5. Publish the issues to the issue tracker

For each approved slice, publish a new issue to the issue tracker. Use the issue body template below. Apply the `needs-triage` triage label so each issue enters the normal triage flow.

Publish issues in dependency order (blockers first) so you can reference real issue identifiers in the "Blocked by" field.

When the slice set came from an existing tracker PRD/parent issue, include that reference under **Parent** in each published issue body.

<issue-template>
## Parent

A reference to the parent PRD or parent issue on the issue tracker (if one exists — e.g. the PRD epic or planning issue — otherwise omit this section).

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

---
name: to-prd
description: Turn the current conversation context into a PRD and publish it to the project issue tracker. Use when user wants to create a PRD from the current context.
---

This skill takes the current conversation context and codebase understanding and produces a PRD. Do NOT interview the user — just synthesize what you already know.

The issue tracker and triage label vocabulary should have been provided to you — run `/setup-matt-pocock-skills` if not.

## Tracker labels

On every published PRD issue (`issue_write` `create`), set `labels` to include **`needs-triage`** plus the correct scope label(s) from this table (repo: **TheHexaForge/TaleTailorBackend**).

| Label | Apply when |
|-------|------------|
| `frontend` | Primary work is in **Storytailor-Frontend** (UI, routing, i18n, client HTTP integration, FE tests). Typical for PRDs produced by `/implement` in the frontend repo. |
| `backend` | Primary work is in **TaleTailorBackend** (API, DB/migrations, server logic, published OpenAPI on the server). No meaningful FE deliverable in this issue. |
| `frontend` + `backend` | The PRD describes a coordinated initiative with **substantial** planned work in **both** repos in one planning artifact. Prefer a single scope label when the PRD is clearly owned by one side; child slices from `prd-to-issues` can split labels per slice. |

Classify from **Implementation decisions** and **User stories** (which layers they touch), not from the tracker repo name alone.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the PRD, and respect any ADRs in the area you're touching.

2. Sketch out the major modules you will need to build or modify to complete the implementation. Actively look for opportunities to extract deep modules that can be tested in isolation.

A deep module (as opposed to a shallow module) is one which encapsulates a lot of functionality in a simple, testable interface which rarely changes.

Check with the user that these modules match their expectations. Check with the user which modules they want tests written for.

3. Make replacement decisions explicit. The PRD should plan for one current path, not legacy compatibility. Do **not** specify long-lived legacy branches, fallback shapes, compatibility shims, deprecated aliases, or migration code unless the user has explicitly requested a time-bound compatibility window with a tracker issue for removal.

When the feature supersedes an existing contract or flow:

- Update callers to the new path and remove the old path as part of the work.
- Match the current OpenAPI/schema/route/component contract only; do not include "old shape or new shape" behavior.
- Treat active feature flags as temporary rollout mechanics only, with cleanup included once rollout is final.
- Put any genuinely required, product-approved compatibility window under **Out of Scope** or **Further Notes** with the required removal ticket.

4. Write the PRD using the template below, then publish it to the project issue tracker via GitHub MCP `issue_write` (`method`: `create`) per `github-mcp` skill. Set `labels` to **`needs-triage`** plus **`frontend`**, **`backend`**, or **both**, per **Tracker labels** above.

<prd-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions
- Which existing flows/contracts are replaced and removed, with no legacy fallback or migration code

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Do NOT include compatibility shims, deprecated aliases, dual parsers, fallback field mappings, or migration branches as implementation decisions. If a temporary compatibility window is explicitly required, note the product reason and removal tracker issue instead.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this PRD.

## Further Notes

Any further notes about the feature.

</prd-template>

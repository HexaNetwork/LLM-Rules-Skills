---
name: diagnose-jira-ticket
description: >-
  Fetches a Jira bug ticket via Atlassian MCP, always creates or checks out a
  sprint-prefixed git branch ({prefix}_{issueKey}), then runs the diagnose
  workflow. Use when the user says /diagnose-jira-ticket, /diagnose-jira, pastes
  a Jira key or URL (e.g. CIVSUP-1057), or wants to debug a ticketed bug with
  branch setup.
disable-model-invocation: true
---

# Diagnose Jira ticket

Orchestration skill: **Jira context + branch prep**, then hand off to [diagnose/SKILL.md](../diagnose/SKILL.md).

**Branch setup is mandatory.** When this skill is triggered, you must create or check out `{prefix}_{issueKey}` before summarizing the bug, diagnosing, or editing code. Do not stay on the current branch (e.g. `ob-3`) for ticket work. This overrides the default "stay on current branch" rule.

Copy and update:

```
Diagnose Jira progress (ticket: ___ / branch: ___):
- [ ] Step 1 — Normalize ticket key
- [ ] Step 2 — Fetch Jira issue + comments
- [ ] Step 3 — Create or checkout ticket branch (required)
- [ ] Step 4 — Summarize bug context
- [ ] Step 5 — Run diagnose phases 1–6
```

## Step 1 — Normalize ticket key

Accept: full key (`CIVSUP-1057`), numeric id (`1057`), or Jira URL.

| Input | Action |
|-------|--------|
| URL with `/browse/PROJ-123` | Extract `PROJ-123` |
| `PROJ-123` | Use as-is (uppercase) |
| `1057` only | Default project `CIVSUP` → `CIVSUP-1057`. If prefix on current branch looks like a ticket (`S13_CIVSUP-119`), reuse that project from the suffix instead. Otherwise ask once. |

## Step 2 — Fetch Jira issue

Use **Atlassian MCP** via the marketplace plugin server (`plugin-atlassian-atlassian`). Read the tool schema before calling.

1. **cloudId:** For CivCraft / `CIVSUP-*` tickets, use `hexa-network.atlassian.net` (not `civcraft.atlassian.net`). If the user pasted a Jira URL, use that hostname as `cloudId`. Otherwise call `getAccessibleAtlassianResources` once and pick the site that hosts the project.
2. `getJiraIssue` with `cloudId`, `issueIdOrKey`, `fields` including `comment`, and `responseContentFormat`: `markdown`.
3. Optionally `getJiraIssueRemoteIssueLinks` and `getTeamworkGraphContext` when links to PRs, branches, or deployments would speed up repro.

If MCP is unavailable, stop and ask the user to paste summary + description + recent comments.

## Step 3 — Branch naming and checkout (required)

Run this step **immediately after** fetching the Jira issue and **before** any diagnosis, code search, or file edits.

**Prefix** from the current branch (`git branch --show-current`):

- If the branch contains `_`, prefix = text **before the first** `_`.
- Otherwise prefix = full branch name.

Examples: `ob-3` → `ob-3`; `S13` → `S13`; `S13_CIVSUP-119` → `S13`.

**Target branch name:** `{prefix}_{issueKey}` (e.g. `ob-3_CIVSUP-1057`, `S13_CIVSUP-1057`).

**Checkout rules** (run in repo root):

1. If already on `{prefix}_{issueKey}` → announce branch and continue (only case where checkout is skipped).
2. If `{prefix}_{issueKey}` exists locally → `git checkout {prefix}_{issueKey}`.
3. Else if it exists on remote only → fetch if needed, then `git checkout -b {prefix}_{issueKey} --track origin/{prefix}_{issueKey}`.
4. Else → `git checkout -b {prefix}_{issueKey}` from current HEAD.

Do **not**:

- Stay on the parent branch (`ob-3`, `S13`, etc.) while working the ticket.
- Invent a different branch name.
- Skip this step because work already started on the wrong branch. Check out the ticket branch first; uncommitted changes carry over via git checkout when applicable.

Announce: starting branch, prefix used, target branch, and whether it was created or checked out.

## Step 4 — Summarize bug context

Before diagnosing, show a short structured summary from Jira:

- **Key**, **title**, **status**, **priority**, **type**
- **Reporter / assignee** (if present)
- **Description** (repro steps, expected vs actual)
- **Recent comments** (last 3–5 substantive ones; skip bot noise)
- **Linked PRs / branches** from remote links or Teamwork Graph (if fetched)

Ask the user only if repro steps or environment are still unclear after Jira.

## Step 5 — Run diagnose

Read [diagnose/SKILL.md](../diagnose/SKILL.md) and follow **all phases** (1–6). Use the Jira summary as the user's bug report in Phase 2.

When declaring done (diagnose Phase 6):

- Reference the Jira key in commit/PR messages when the user commits.
- Note whether a regression test was added or why no seam existed.

## MCP quick reference

| Task | Tool |
|------|------|
| Issue body + comments | `getJiraIssue` (`fields`: include `comment`) |
| Linked PRs / deploys | `getJiraIssueRemoteIssueLinks`, `getTeamworkGraphContext` |
| Find issue by partial key | `searchJiraIssuesUsingJql` |

Always read tool descriptors in the MCP folder before calling.

## Examples

**User:** `/diagnose-jira-ticket CIVSUP-1057` while on `ob-3`

1. Fetch `CIVSUP-1057` from Jira.
2. `git checkout -b ob-3_CIVSUP-1057` (required before any other work).
3. Summarize ticket, then diagnose phases 1–6.

**User:** `diagnose 119` while on `S13_CIVSUP-218`

1. Normalize → `CIVSUP-119` (project from existing ticket suffix).
2. Prefix → `S13`; branch → `S13_CIVSUP-119`.
3. Checkout existing or create, then diagnose.

**Wrong:** Fetch Jira, search codebase, edit files, all while still on `ob-3`.

**Right:** Fetch Jira → `git checkout -b ob-3_CIVSUP-1044` → summarize → diagnose.

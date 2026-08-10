---
name: diagnose-jira-ticket
description: >-
  Fetch a Jira bug through an available Atlassian integration, prepare a
  ticket-specific branch, then run the diagnose workflow. Use when the user
  names this skill, supplies a Jira key or URL, or asks to debug a Jira ticket.
disable-model-invocation: true
---

# Diagnose Jira ticket

This orchestration skill combines Jira context and branch preparation with [diagnose](../diagnose/SKILL.md).

## 1. Resolve the ticket

Accept a full issue key or Jira URL. Extract and uppercase the key. A numeric-only identifier is ambiguous unless the project key is established by the conversation or project configuration; otherwise ask for the project key.

Use the Atlassian connector or MCP tools exposed by the active agent environment. Read the available tool schema before calling it. Resolve the Jira site from the supplied URL or the integration's accessible-resource listing—never hardcode a tenant.

Fetch the issue body and substantive comments. Fetch linked development information only when it helps reproduce or diagnose the bug. If no Jira integration is available, ask the user to provide the issue body and relevant comments.

## 2. Prepare the branch

Before editing, inspect the repository's git policy and current worktree. Use the configured branch prefix or repository naming convention to derive a ticket branch such as `{prefix}/{issueKey}`. Do not invent a project-specific prefix.

If branch creation or checkout would conflict with uncommitted work, stop and ask before moving changes. Otherwise reuse an existing local or remote ticket branch when present, or create it from the current approved base. Report the starting and target branch.

## 3. Summarize the bug

Record:

- Key, title, status, priority, and issue type
- Reporter and assignee when relevant
- Reproduction steps and environment
- Expected versus actual behavior
- Recent substantive comments
- Linked changes or deployments that may affect diagnosis

Ask a focused question only when the ticket and repository do not establish a usable reproduction target.

## 4. Diagnose

Read and follow [diagnose](../diagnose/SKILL.md). Use the Jira summary as the bug report. Finish with the root cause, evidence, validation performed, regression-test status, and any remaining uncertainty. Reference the issue key in later commit or pull-request text when the user authorizes those actions.

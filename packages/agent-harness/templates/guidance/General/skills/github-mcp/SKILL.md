---
name: github-mcp
description: >-
  GitHub issues and pull requests through an available GitHub integration.
  Use for reading or creating issues, opening PRs, PR review threads, and CI status.
---

# GitHub integration

Use the GitHub connector or MCP tools exposed by the active agent environment. Read the available tool schema before calling it; tool names can differ between environments. Do not assume a Cursor configuration path or embed credentials in repository files.

**Repo context:** Parse `owner` and `repo` from the GitHub issue/PR URL or `git remote` when the host is `github.com`. If the code remote is not GitHub, take `owner`/`repo` from the tracker link in the issue or contract.

## Common MCP tool map

| Task | MCP tool | Notes |
|------|----------|--------|
| View issue | `issue_read` | `method`: `get`; pass `owner`, `repo`, `issue_number` |
| Issue comments | `issue_read` | `method`: `get_comments` |
| Sub-issues | `issue_read` | `method`: `get_sub_issues` |
| Link sub-issue | `sub_issue_write` | `method`: `add`; `issue_number` = parent; `sub_issue_id` = child **id** (from `issue_read` `get`, not issue number) |
| Create issue | `issue_write` | `method`: `create`; `title`, `body`, optional `labels` |
| Update issue | `issue_write` | `method`: `update`; `issue_number`, `state`, `labels`, `assignees`, etc. |
| Authenticated user | `get_me` | `login` for assignee on triage pickup |
| Search issues | `search_issues` | GitHub issue search `query` |
| List issues | `list_issues` | Filter by `state`, `labels` |
| Open PR | `create_pull_request` | `title`, `head`, `base`, `body`; link issues in `body` |
| PR details | `pull_request_read` | `method`: `get` |
| PR diff / files | `pull_request_read` | `method`: `get_diff` or `get_files` |
| PR review threads | `pull_request_read` | `method`: `get_review_comments` (unresolved threads for babysit) |
| PR CI checks | `pull_request_read` | `method`: `get_check_runs` or `get_status` |
| List PRs | `list_pull_requests` | `state`, `head`, `base` filters |
| Search PRs | `search_pull_requests` | PR search `query` |
| Merge PR | `merge_pull_request` | `pullNumber`, optional `merge_method` |
| Reply on PR review | `add_reply_to_pull_request_comment` | `commentId`, `body` |

## PR body

Use markdown in `body` for Summary / Test plan. Reference child issues with `Fixes #N` or `Closes #N` in the description.

## Babysit / review comments

1. `pull_request_read` with `method`: `get_review_comments`.
2. Act only on **unresolved** threads; read comment body + file/line from the tool payload (do not dump full raw JSON).
3. Reply with `add_reply_to_pull_request_comment` when a response is needed.

## When MCP is unavailable

If no GitHub integration is available, stop before any remote mutation and tell the user which capability is missing. A read-only local `git` inspection may continue when it still answers the request. Do not install tooling, request credentials, or switch to another remote client without the user's approval.

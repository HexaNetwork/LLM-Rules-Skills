---
name: harness-run
description: Operate the lean Agent Harness from an idea or ticket through its durable six-step workflow and host-owned pull request. Use when the user asks to start, answer, retry, inspect, cancel, publish, or observe a harness run.
---

# Harness Run

Treat the coordinator API, dashboard, and external harness home as authoritative.
Use chat only as an operator client. The target repository contains neither
harness configuration nor run state.

## Open the control plane

Start the coordinator, then use its loopback dashboard for interactive work:

```bash
npx agent-harness serve
```

The dashboard is at `http://127.0.0.1:8787` by default. It and the CLI are API
clients, not lifecycle owners. Use `--home <path>` or `AGENT_HARNESS_HOME` only
when the operator explicitly wants a different external harness home.

## Register and start

Execution requires Docker, the explicitly installed neutral runner image, and
`CURSOR_API_KEY`.

```bash
npx agent-harness project add --name project --repository "/path/to/project" --base-branch main
npx agent-harness project list
npx agent-harness start --project <project-id> --idea "<idea>"
npx agent-harness start --project <project-id> --idea "<ticket>" --workflow ticket
```

## Handle human gates

When a run returns `awaiting_user`, present only its current gate. Clarify has
an editable brief and material-unknown batches; Specify has explicit document
approval; Publish has editable pull-request text. Never answer a gate for the
operator.

```bash
npx agent-harness answer --run-id <id> --gate-id <gate-id> --answers '{"<question-id>":"<answer>"}'
```

## Resume and inspect

```bash
npx agent-harness status --run-id <id>
npx agent-harness retry --run-id <id>
npx agent-harness cancel --run-id <id>
npx agent-harness publish --run-id <id>
```

If a run is blocked, inspect its timeline, environment diagnostics, artifacts,
and latest turn. Correct the reported external state before retrying. Do not
create an unbounded retry loop.

Do not reproduce workflow work in chat, invent provider sessions, run tests or
Git for an active transition, edit SQLite/artifact rows manually, or auto-merge
a pull request. A run is finished only when its status is `completed`.

---
name: harness-run
description: Operate the fresh modular Agent Harness from an idea through an intent-first workflow and host-owned pull request. Use when the user asks to start, continue, answer, retry, inspect, cancel, or observe a harness run.
---

# Harness Run

Treat the CLI, dashboard, and external harness home as authoritative. Use chat
only as an operator client. The target repository does not contain harness
configuration or run state.

The topology follows ADR 0018: one host process, one Linux container per run,
the run worktree at `/workspace`, and `CURSOR_API_KEY` in the container
environment. There is no provider proxy, proof-tuple gate, frozen run
configuration, worker preparation command, or pre-rewrite run migration.

## Open the control plane

Prefer the authenticated loopback dashboard for interactive operation:

```bash
npx agent-harness ui --repository "/path/to/project"
```

Use the tokenized URL printed by the command. The dashboard is a client of the
same run lifecycle as the CLI, not a separate state owner.

Use `--home <path>` or `AGENT_HARNESS_HOME` only when the operator wants to
override the platform-default external harness home.

## Register and start

Register the repository once. Real Cursor execution requires Docker and
`CURSOR_API_KEY`; fake-agent workflows do not.

```bash
npx agent-harness project add --repository "/path/to/project"
npx agent-harness start --idea "<idea>"
npx agent-harness start --idea @idea.md --repository "/path/to/project"
npx agent-harness start --idea "<idea>" --workflow ticket --repository "/path/to/project"
```

The default workflow is intent-first. There is no per-run TDD toggle. A run
pins identity only; project/profile settings remain live.

## Handle human questions

When a run returns `awaiting_input`, present only its current gate:

- **Reflect** questions include a draft restatement. Let the operator edit it before confirming; the confirmed text becomes the grill brief.
- **Grill** questions include context, options, tradeoffs, and a recommendation. Leave room for a custom answer.
- **Operator gate** presents the planning artifacts for explicit approval.

Never answer a HITL question for the user.

Record answers exactly as a question-id-to-answer JSON object:

```bash
npx agent-harness answer --run-id <id> --answers '{"<question-id>":"<answer>"}'
npx agent-harness answer --run-id <id> --answers '{"approve":"yes"}' --notes "<optional notes>"
```

## Resume and inspect

```bash
npx agent-harness status --run-id <id>
npx agent-harness continue --run-id <id>
npx agent-harness retry --run-id <id>
npx agent-harness cancel --run-id <id>
```

If a run is blocked, inspect its dashboard activity, artifacts, and latest
session under the external harness home. Correct the reported external state
or live project settings before `retry`. The next advance re-reads settings and
records the effective snapshot. Do not create an unbounded retry loop.

## Preserve orchestration boundaries

- Do not reproduce phases, retries, verification, review, or Git steps in chat.
- Do not resume or invent provider sessions manually; persisted packets and the
  worktree are the recovery boundary.
- Do not run tests or Git on behalf of an active transition.
- Do not edit `state.json` manually.
- Do not auto-merge a pull request.

The run is finished only when its status is `completed`. Host-owned publication
may push and open a pull request; it never auto-merges.

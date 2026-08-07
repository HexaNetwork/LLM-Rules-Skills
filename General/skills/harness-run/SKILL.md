---
name: harness-run
description: Run or resume the durable Agent Harness idea-to-feature workflow, including Wayfinder decision mapping, persisted human questions, local retrieval, optional TDD, deterministic test repairs, and harness-owned commits or pull requests. Use when the user explicitly asks to use the harness, continue a harness run, answer a harness question, inspect a blocked run, or launch autonomous feature delivery.
---

# Harness Run

Treat the CLI and `.agent-harness/runs/<runId>/state.json` as authoritative. Use chat only as an operator client.

## Open the control plane

Prefer the centralized local dashboard when the user wants to operate or observe the workflow in one place:

```bash
npx agent-harness ui
```

Use the tokenized loopback URL printed by the command. The dashboard can create runs, answer HITL questions, inspect deterministic command evidence and session handoffs, retry or cancel work, read artifacts, and manage local knowledge. It is a client of the same durable engine as the CLI, not a separate state owner.

## Start

Require a clean git working tree, an initialized `agent-harness.config.yaml`, and `CURSOR_API_KEY` for real agents.

```bash
npx agent-harness start --idea "<idea>"
npx agent-harness start --idea @idea.md --tdd on
```

These CLI commands remain useful for automation and headless operation; the dashboard exposes the same start controls, including the per-run TDD choice and model overrides.

Use `--tdd off` only when the user chooses implementation-first. Do not reinterpret the toggle during a resumed run; the harness freezes it in `config.json`.

## Handle human questions

When the run returns `awaiting_input`, present only the open question and its decision-ticket title, including the persisted context, options, tradeoffs, and recommendation. Leave room for a custom answer. Never answer a HITL question for the user.

Record the answer exactly, then let the bounded wayfinding episode continue from the persisted conversation:

```bash
npx agent-harness answer --run-id <id> --question <question-id> --text "<answer>"
```

## Resume and inspect

```bash
npx agent-harness status --run-id <id> --json
npx agent-harness continue --run-id <id>
```

If the run is blocked, inspect `state.json`, `events.jsonl`, the current task or issue, and the latest failed session. Correct external state or configuration before running `retry`. Do not create an unbounded manual retry loop.

## Preserve orchestration boundaries

- Do not reproduce Wayfinder, retries, testing, review, or git steps in chat.
- Let the harness resume its persisted wayfinding episode; do not resume or invent provider sessions manually. Every turn still has a complete persisted packet for recovery.
- Do not run tests or git on behalf of an active harness transition.
- Do not edit `state.json` manually.
- Do not auto-merge a pull request.

Use `map.md` for orientation, then open only the relevant issue or task. Treat the map as an index and the ticket resolution as the detailed source of truth.

The run is finished only when its phase is `completed` and every implementation task is `done`.

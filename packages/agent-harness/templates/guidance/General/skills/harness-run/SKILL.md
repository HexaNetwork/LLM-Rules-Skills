---
name: harness-run
description: Run or resume the durable Agent Harness idea-to-feature workflow, including reflect confirmation, grill-me interviews, persisted human questions, local retrieval, scenario testing, crystallizing, deterministic repairs, and harness-owned commits or pull requests. Use when the user explicitly asks to use the harness, continue a harness run, answer a harness question, inspect a blocked run, or launch autonomous feature delivery.
---

# Harness Run

Treat the CLI and `.agent-harness/runs/<runId>/state.json` as authoritative. Use chat only as an operator client.

## Open the control plane

Prefer the centralized local dashboard when the user wants to operate or observe the workflow in one place:

```bash
npx agent-harness ui
```

Use the tokenized loopback URL printed by the command. The dashboard can create runs, confirm editable reflect briefs, answer grill questions, inspect deterministic command evidence and session handoffs, retry or cancel work, read artifacts, and manage local knowledge. It is a client of the same durable engine as the CLI, not a separate state owner.

## Start

Require a clean git working tree, an initialized `agent-harness.config.yaml`, and `CURSOR_API_KEY` for real agents.

```bash
npx agent-harness start --idea "<idea>"
npx agent-harness start --idea @idea.md
```

These CLI commands remain useful for automation and headless operation; the dashboard exposes the same start controls and model overrides. Each run freezes the project config into its snapshot so later project edits cannot silently change an active run.

## Handle human questions

When the run returns `awaiting_input`, present only the open question:

- **Reflect** questions include a draft restatement. Let the operator edit it before confirming; the confirmed text becomes the grill brief.
- **Grill** questions include context, options, tradeoffs, and a recommendation. Leave room for a custom answer.

Never answer a HITL question for the user.

Record the answer exactly, then let the bounded grill episode continue:

```bash
npx agent-harness answer --run-id <id> --question <question-id> --text "<answer>"
```

Answers older than `workflow.staleAnswerMinutes` (30 by default) force a fresh agent with only the question and answer. Grill episodes also roll after `workflow.maxGrillQuestionsPerEpisode` answered questions.

## Resume and inspect

```bash
npx agent-harness status --run-id <id> --json
npx agent-harness continue --run-id <id>
```

If the run is blocked, inspect `state.json`, `events.jsonl`, the current task, and the latest failed session. Correct external state or configuration before running `retry`. Do not create an unbounded manual retry loop.

## Preserve orchestration boundaries

- Do not reproduce reflect, grill, retries, testing, review, or git steps in chat.
- Let the harness resume its persisted grill episode; do not resume or invent provider sessions manually. Every turn still has a complete persisted packet for recovery.
- Do not run tests or git on behalf of an active harness transition.
- Do not edit `state.json` manually.
- Do not auto-merge a pull request.

Use `brief.md` and `grill.md` for orientation, then open only the relevant task. Treat the confirmed brief plus grill resolutions as the planning source of truth.

The run is finished only when its phase is `completed` and every implementation task is `done`.

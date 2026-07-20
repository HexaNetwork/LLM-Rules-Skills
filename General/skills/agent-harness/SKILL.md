---
name: agent-harness
description: >-
  Run the Agent Harness CLI for contract-deterministic AFK implementation:
  prepare/approve/execute/resume manifests with Cursor SDK workers and verifiers.
  Use when the user says /agent-harness, agent-harness, or asks to execute an
  approved implementation run outside the prose implement-auto loop.
disable-model-invocation: true
---

# Agent Harness (`/agent-harness`)

Prefer the executable CLI over re-implementing orchestration in chat.

Package: `packages/agent-harness` in LLM-Rules-Skills (`@hexanetwork/agent-harness`).

## When to use

- Running an AFK implementation queue from a local task bundle or GitHub entry issue
- Resuming a crashed harness run
- Checking run status / producing a final report

## Do not

- Re-create per-issue agent loops, review storms, or ad-hoc commit gates in prose
- Change product acceptance criteria during prepare
- Execute HITL tasks (v1 rejects them)
- Auto-merge PRs or close issues

## Operator flow

```bash
npx agent-harness init
npx agent-harness prepare --local tasks.yaml   # or --github <n>
npx agent-harness approve --draft <draft.json>
npx agent-harness execute --manifest <manifest.json>
npx agent-harness status --run-id <id>
npx agent-harness resume --run-id <id>
```

Use `--fake-agents` only for dry harness tests without `CURSOR_API_KEY`.

## Vocabulary

See repo-root `GLOSSARY.md` (run manifest, worker, verifier, gate, repair attempt).

## Related skills

- `implement-auto` — legacy prose orchestrator; delegates executable runs here
- `tdd` — outcome guidance for workers (harness gates outcomes, not private red/green sequencing)
- `code-review` / adversarial review — subsumed by harness verifier roles during execute

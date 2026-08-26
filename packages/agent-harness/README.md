# Agent Harness

Turns an idea into verified, committed feature slices. One host process composed
with `@deepseek-ai/cordis`. One Linux container per run. Live project settings.
No frozen run configuration.

Package: `@hexanetwork/agent-harness`. Binary: `agent-harness`.

Design rules (project-agnostic, deterministic-first, lean UI):
[design.md](./design.md).

## Quick start

Requires Node.js 20.3+ and Docker (Linux containers) for isolated agent
execution. Fake-agent workflows do not need Docker.

On Windows, double-click `scripts\Launch-AgentHarness.cmd`. See
[INSTALL.md](../../INSTALL.md).

```bash
npm install
npm run build
npx agent-harness dump-config
npx agent-harness project add --repository "/path/to/your-project"
npx agent-harness start --idea "Add a health check" --repository "/path/to/your-project"
npx agent-harness ui --repository "/path/to/your-project"
```

`CURSOR_API_KEY` is passed into the run container as environment. `GITHUB_TOKEN`
stays on the host for publish. There is no provider proxy, proof-tuple launch
gate, or frozen-config fixer.

Pre-rewrite runs are unsupported.

## Lifecycle

```text
idea → reflect → grill → glossary → verification-settings
    → plan + PRD + scenarios → operator-gate → slice
    → implement (per-task review, host commit)
    → scenario-test → crystallize (optional coverage)
    → final-review → publish (host push + PR)
```

Stops: `awaiting_input`, `blocked`, `cancelled`, `completed`.

Settings (verification command, budgets, models, and the all-agent wall-clock
timeout) are re-read on every
advance. Per-role guidance is resolved live from project, harness-home, or
packaged `GUIDANCE.md`. A run pins only identity: `runId`, workflow bundle id,
worktree, `baseSha`.

The dashboard Settings page edits `workflow.agentTimeoutMinutes` globally or
as a project override. The default is 30 minutes; valid values are 1–1440.
When the deadline expires, the worker cancels the provider run when supported,
exits, and the host also enforces a short process-level fallback deadline.

## Session audit and usage

Every model invocation is written beneath the external harness home at
`runs/<runId>/sessions/<sessionId>.json`. The record contains the complete work
packet, configured and provider-resolved model, role (agent type), timestamps,
provider run identifiers, output or error, token telemetry, and provider-billed
cost when Cursor reports it. Failed calls are retained too.

The dashboard **Overview** tab shows usage totals broken down by model and agent
type; the **Sessions** tab shows the individual audit records.
`GET /api/runs/<runId>/usage` exposes the same aggregate.
Missing or eventually-consistent provider cost is marked as unavailable and is
never estimated from a local price table.

## Workflows

| Bundle | Phases |
| --- | --- |
| Feature (`default`) | reflect through publish |
| `ticket` | implement → scenario-test → publish |

```bash
agent-harness start --idea "Fix the timeout copy" --workflow ticket --repository "/path/to/your-project"
```

Target repositories cannot install plugins.

## Isolation

```text
Host: workflow, dashboard, CLI, durable state, GITHUB_TOKEN, Git, Docker lifecycle
  → one Linux container per run
  → bind run worktree at /workspace
  → env: CURSOR_API_KEY
  → never: GH tokens, harness home, sibling runs, Docker socket, control checkout
```

Live Cursor is opt-in. Isolation is proven by mount list, secret absence, and an
unchanged control checkout.

## Commands

```bash
agent-harness dump-config
agent-harness project add --repository <path>
agent-harness project list
agent-harness start --idea "..." [--workflow default|ticket]
agent-harness continue --run-id <id>
agent-harness answer --run-id <id> --answers '{"restatement":"yes"}'
agent-harness retry --run-id <id>
agent-harness cancel --run-id <id>
agent-harness status --run-id <id>
agent-harness ui [--port 8787] [--repository <path>]
```

## Tests

```bash
npm run test:unit
npm run test:integration
npm run test:docker
```

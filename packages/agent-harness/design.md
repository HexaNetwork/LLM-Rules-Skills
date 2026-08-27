# Agent harness design

Standing rules for `@hexanetwork/agent-harness`. Architecture decisions live in
[`docs/adr/`](../../docs/adr/); this file is the short product/engineering
contract for how we build and change the harness.

The harness turns an idea into verified, committed feature slices for **any**
registered repository. Host process, Cordis plugins, workflow bundles, and the
loopback dashboard are the product — not a single app’s domain.

## Core rules

### 1. Project-agnostic

- Default workflows, phases, roles, and packaged guidance must work for any
  registered repo. Do not bake product names, repo layouts, or app-specific
  vocabulary into harness code or packaged role guidance.
- Project-specific behavior belongs in live settings, per-project role
  overrides, or the target repository itself — never in host internals.
- Target repositories cannot install harness plugins. Profiles stay trusted
  host software.

### 2. Prefer deterministic code over agents

- If a step can be a script, schema check, filesystem write, Git operation, or
  plain TypeScript, do that. Agents are for judgment and synthesis only.
- Host owns orchestration, durable state, commit/push/PR, Docker lifecycle, and
  verification command execution. Workers receive bounded packets and return
  contracts; they do not own the loop.
- Before adding a new worker role or agent call, ask whether a deterministic
  phase, parser, or template can do the same work cheaper and more reliably.
- Fake-agent / scripted paths are first-class for tests and local dry runs.

### 3. Precise, short agent context — clear outputs

- Keep worker prompts short: role identity, hard rules, **EXPECTED OUTPUT**
  contract, then the effective `GUIDANCE.md` body. Shape inputs in phase
  builders; cap only external retrieval excerpts (`budgets.graphifyTokens`).
- Every role has an explicit JSON output contract (`ROLE_OUTPUT_CONTRACTS`).
  Phases parse and validate that shape; vague free-form reports are a defect.
- Work packets must state inputs, constraints, and the expected return value
  clearly. Prefer one raw JSON object — no Markdown wrappers or code fences
  unless a phase explicitly requires artifact files.
- Role guidance is the sole worker instruction source (see ADR 0020). Do not
  reintroduce silent rule/skill injection that conflicts with contracts.

### 4. Configurable by default

- Settings that operators may tune (verification command, test globs, budgets,
  models, coverage) are live project/profile knobs, re-read on every advance —
  not frozen into the run identity.
- A run pins only identity: `runId`, workflow bundle id, worktree, `baseSha`.
- Prefer settings, workflow bundle config, and layered guidance overrides over
  code forks when behavior needs to vary by project or operator.

### 5. Modular composition

- One host process composed with Cordis. Phases, workflows, store, agents,
  sandbox, git, dashboard, and run lifecycle are separate plugins with clear
  seams.
- Workflow bundles are ordered phase ids plus terminals. Adding a bundle (e.g.
  `ticket`) must not require editing `runLifecycle` internals.
- A phase that only delegates to a monolith `advance()` is a failed review —
  phases own real `enter` / `advance` / `onAnswer` behavior.
- Prefer small, replaceable modules over cross-cutting special cases.

## UI

The dashboard is an authenticated loopback **client** of the same
`runLifecycle` API as the CLI (ADR 0003). It owns no durable lifecycle state.

### Overview is user-facing

- The **Overview** tab is the primary operator surface: status, current gate,
  and what needs attention. Keep it clean — decision-ready, not a dump of
  raw artifacts or session noise.
- Detail (activity, sessions, sandbox, artifacts) stays on secondary tabs.
  Do not clutter Overview with diagnostics operators only need when debugging.

### Approvals are editable

- When the harness asks for confirmation (reflect brief, grill batch, operator
  gate, verification settings, and similar), present agent-proposed values in
  **editable fields**.
- Operators must be able to tweak titles, restatements, lists, plan/PRD text,
  notes, and other submitted payloads before Approve / Continue.
- Submitted answers are whatever the operator left in the form — not a
  read-only replay of the last agent JSON.

### Prefer lean UI

- Reduce noise: one job per panel, short labels, minimal chrome.
- Avoid decorative cards, dense metadata strips, and competing callouts on the
  primary path.
- Polling and refresh must preserve in-progress drafts and scroll position;
  background observation must not feel like a full page reload.

## How to use this doc

When reviewing a harness change, check:

1. Does it stay project-agnostic?
2. Could deterministic code replace a new agent call?
3. Is worker context short, with a crisp JSON (or file) contract?
4. Are knobs configurable without code changes where that makes sense?
5. Does the change keep modules and workflow bundles composable?
6. If UI: is Overview clean, are approval fields editable, and is the surface lean?

Conflict with an ADR: update or supersede the ADR; do not silently diverge.

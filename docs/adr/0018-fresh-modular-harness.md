# ADR 0018: Fresh modular harness — live settings, one container, real phase plugins

## Status

Accepted. **Supersedes** the isolation and topology decisions in
[ADR 0015](0015-docker-isolated-runs.md),
[ADR 0016](0016-docker-only-host-owned-state.md), and
[ADR 0017](0017-cordis-composed-docker-runtime.md). Amends the run-configuration
freeze clause of [ADR 0002](0002-durable-wayfinder-harness.md): a run pins
identity only; project and profile settings are re-read on every advance.

Product ideas that remain in force: durable filesystem artifacts (0002),
loopback dashboard as a client (0003), complete work packets (0004 / 0007),
visible fog and batched grill (0008), external harness home and zero-footprint
targets (0011). Pre-rewrite run state is unsupported.

## Context

The v2 tree accumulated a dual runtime, frozen run configuration, a host
provider proxy, proof-tuple launch gates, disposable-per-invocation sandboxes,
`/run-state` RPC, and a Cordis facade whose every phase called a monolith
`advance()`. Those layers blocked a golden path: register any repo, start from
an idea, reach a host-owned PR, without infrastructure repair.

The rewrite keeps the package name `@hexanetwork/agent-harness` and the binary
`agent-harness`. Old runs die. Target repositories cannot install plugins.

## Decision

### Identity freeze, live settings

A run pins only identity:

- `runId`
- workflow bundle id
- worktree path and `baseSha`

Project and profile settings (verification command, test globs, budgets,
coverage, models, guidance) are re-read on every `start` / `continue` /
`answer` / `retry`. Changing a knob and hitting Continue applies it. The
effective snapshot is appended to a per-run audit log. There is no
`configurationHash`, `CONFIG_VERSION` migration, frozen-components snapshot, or
config-fixer role.

### Isolation topology

```text
Host: workflow, dashboard, CLI, durable state, GITHUB_TOKEN, Git publish, Docker lifecycle
  → one Linux container per run
  → bind run worktree at /workspace
  → env: CURSOR_API_KEY
  → never: GH tokens, harness home, sibling runs, Docker socket, control checkout
Container: @cursor/sdk Agent.create({ local: { cwd: "/workspace" } })
```

One container per run: recreate on crash, destroy on complete or cancel. Cursor
inner sandbox is defense in depth. Pollution and host secrets are the wall.
`CURSOR_API_KEY` in the container environment is accepted. There is no provider
proxy, custom CA, route allowlist, or proof-tuple launch gate.

The required Docker proof is mount-list + no host secrets + unchanged control
checkout. Live Cursor smoke is opt-in and is never a CI or launch gate.

### Composition

Reuse `@deepseek-ai/cordis` already in the package. One host process. The
container is only where `@cursor/sdk` and project tools live — not a second
harness.

```text
CLI / Dashboard
    → ctx.runLifecycle   start / continue / answer / retry / cancel
    → ctx.workflow       ordered phase plugins + terminals
    → ctx.phases         real enter / advance / onAnswer handlers
    → ctx.agents         bounded SDK invocation via sandbox
    → ctx.packets        prompt budget authority
    → ctx.store          host filesystem artifacts
    → ctx.git            host worktree, commit, push, PR
    → ctx.sandbox        one Docker container per run
    → ctx.knowledge      live guidance (no freeze copy)
    → ctx.commands       verification / coverage inside the sandbox
```

Profiles are trusted host software. A target repository cannot add plugins,
patches, setup commands, or module specifiers.

### Phase contract

A phase that only delegates to a monolith `advance()` is a failed review.
Phases own their own enter / advance / onAnswer:

```ts
type PhaseResult =
  | { kind: "continue"; next?: string }
  | { kind: "await"; gate: GateSpec }
  | { kind: "block"; reason: string; retriable: boolean }
  | { kind: "done" };

interface Phase {
  id: string;
  enter?(run: Run): Promise<void>;
  advance(run: Run, input: AdvanceInput): Promise<PhaseResult>;
  onAnswer?(run: Run, batch: AnswerBatch): Promise<PhaseResult>;
}
```

Workflow bundles are config. The default bundle id is `default`. A later
`ticket` bundle (`implement → scenario-test → publish`) is the modularity proof:
if adding it requires editing `runLifecycle` internals, the seam failed.

### Default product loop

```text
idea → reflect → grill → glossary → verification-settings
    → plan + PRD + scenarios → operator-gate → slice
    → implement (per-task review, host commit)
    → scenario-test → crystallize (optional coverage)
    → final-review → publish (host push + PR)
```

Stops: `awaiting_input`, `blocked`, `cancelled`, `completed`. Same HITL ideas
as today: batched grill + unknowns register, complete work packets, host-owned
Git.

### What we do not port

Provider proxy / TLS / proof tuples; disposable-per-invocation sandboxes;
`/run-state` and worker state RPC; secret-file credential mounts; dual
local/Docker runtime; generated per-run images as a launch ritual; frozen
config machinery; `vnext` phase stubs; pre-rewrite resume or migration.

Keep as **spec**, not code: intent-first phase list, packet budgets, fog/batch
grill, role list, loopback UI-as-client, guidance templates under
`packages/agent-harness/templates`.

### Project-agnostic

The default loop is a workflow bundle any registered repository can run. Do not
name or special-case a target project in code, docs, or tests.

## Consequences

- Operators change live settings and Continue; identity (workflow, worktree)
  cannot change mid-run.
- Isolation evidence is a deterministic mount/secret/checkout test, not a
  credential-gated smoke.
- Phase plugins are the product surface. Workflow bundles swap phase lists
  without a second state machine.
- Pre-rewrite `state.json` and `docker-clone` workspaces are discarded, not
  migrated.
- ADR 0015–0017 remain as decision history only.

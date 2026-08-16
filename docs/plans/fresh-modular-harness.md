# Fresh modular harness — working plan

Greenfield rewrite of `@hexanetwork/agent-harness` (binary `agent-harness`).
Package, workspace, and CLI name stay. Old runs are unsupported. Architecture
authority: [ADR 0018](../adr/0018-fresh-modular-harness.md).

This document is project-agnostic. The default loop is a workflow bundle any
registered repository can run.

## Product loop

```text
idea → reflect → grill → glossary → verification-settings
    → plan + PRD + scenarios → operator-gate → slice
    → implement (per-task review, host commit)
    → scenario-test → crystallize (optional coverage)
    → final-review → publish (host push + PR)
```

Stops: `awaiting_input`, `blocked`, `cancelled`, `completed`.

Human-in-the-loop ideas that stay:

- Reflect produces an editable restatement plus an unknowns seed.
- Grill uses a visible fog register and batched questions (ADR 0008).
- Every agent call is a complete persisted work packet (ADR 0004 / 0007).
- Git commit, push, and PR stay on the host.

Settings that used to be frozen (verification command, test globs, budgets,
coverage, models, guidance) are live project/profile knobs. Changing them and
hitting Continue applies them. Identity cannot change mid-run: `runId`,
workflow bundle id, worktree, `baseSha`.

## Architecture

One host process composed with `@deepseek-ai/cordis`. The container is only
where `@cursor/sdk` and project tools live.

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

Target repositories cannot install plugins. Profiles are trusted host software.

### Phase contract

A phase that only calls a monolith `advance()` is a failed review.

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

### Workflow bundles

Bundles are config: an ordered list of phase ids plus terminals.

| Bundle id | Phases |
| --- | --- |
| `default` | reflect → grill → glossary → verification-settings → plan → prd → scenarios → operator-gate → slice → implement → scenario-test → crystallize → final-review → publish |
| `ticket` | implement → scenario-test → publish |

`ticket` is the modularity proof. Adding it must not require editing
`runLifecycle` internals.

### Isolation

```text
Host owns: workflow, dashboard, CLI, durable state, GITHUB_TOKEN, Git, Docker lifecycle
Container: one Linux container per run
  bind: run worktree → /workspace
  env:  CURSOR_API_KEY
  never: GH tokens, harness home, sibling runs, Docker socket, control checkout
```

Recreate the container on crash. Destroy it on complete or cancel. Required
proof: mount list, no host secrets, control checkout unchanged. Live Cursor is
opt-in, never a launch gate.

### Durable layout

Harness home (ADR 0011) remains external to the target repository:

```text
$AGENT_HARNESS_HOME/
  settings.json                 # global / profile knobs
  projects/<project-key>/
    registration.json           # control root, worktree root
    settings.json               # live project knobs
  runs/<runId>/
    identity.json               # pinned identity only
    state.json                  # phase, status, artifacts, gate
    events.jsonl
    settings-audit.jsonl        # effective snapshot per session
    sessions/<id>.json          # packet + agent output
    artifacts/
```

Pre-rewrite `state.json` and `docker-clone` workspaces are not migrated.

### What we do not port

Provider proxy, custom CA, route allowlist, proof-tuple launch gate,
disposable-per-invocation sandboxes, `/run-state` RPC, secret-file mounts,
dual local/Docker runtime, generated per-run images as a launch ritual,
frozen config / `configurationHash` / `CONFIG_VERSION` / config-fixer,
`vnext` phase stubs, pre-rewrite resume.

Keep as product assets: `packages/agent-harness/templates` guidance.

## Delivery slices

0. Contract docs (this file + ADR 0018; supersede 0015–0017; amend 0002).
1. Cordis host boot + store + `dump-config`. No Docker, no Cursor.
2. Real `reflect` phase + fake agents. `start --idea` → reflecting → awaiting_input.
3. One container per run, key-in-env, SDK inside. Deterministic Docker isolation test.
4. Remaining default-workflow phases as real plugins (grill through publish).
5. Loopback dashboard as a `runLifecycle` client only.
6. `ticket` workflow bundle.
7. Launch scripts + README describe only the new runtime. Tag
   `archive/agent-harness-v2` on the pre-wipe HEAD.

## Tests

- Unit: phase transitions, packet budgets, fog, mount policy, live-settings re-read.
- Integration: default workflow with a fake agent on a temporary git repository.
- Docker isolation when Docker is available: mounts, no host secrets, control checkout unchanged.
- Live Cursor: opt-in only; never a CI or launch gate.

## Golden path

Register any repository. Start from an idea. Reach a host-owned pull request.
No infrastructure repair, no proof-tuple gate, no frozen-config fixer.

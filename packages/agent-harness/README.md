# @hexanetwork/agent-harness

Contract-deterministic orchestration CLI for AFK implementation runs.

## Commands

| Command | Purpose |
|---------|---------|
| `init` | Scaffold `agent-harness.config.yaml` |
| `prepare` | Build a draft run manifest from `--local` or `--github` |
| `approve` | Freeze a draft into an immutable run manifest |
| `execute` | Run an approved manifest in an isolated worktree |
| `resume` | Continue a run after crash/stop (invariant checks) |
| `status` | Print persisted run state |
| `benchmark` | Contract-level repeatability check on fixtures |

## Project config

Required before prepare succeeds. Key fields:

- `models.*` — pinned role models (`prepare`, `worker`, `verifier`, `repair`, `adversarial`)
- `commandGates` — orchestrator-owned shell gates (never guessed)
- `pathPolicy` — protected + default allowed globs
- `retries` — SDK / command / review / final-branch budgets
- `allowlist` — terminal, MCP, network allowlists
- `browser` — optional browser probe settings
- `github` — optional tracker lifecycle + PR publish settings

## Local source

```yaml
tasks:
  - id: greet
    title: Add greet helper
    mode: AFK
    body: Add a greet export
    acceptanceCriteria:
      - id: ac-1
        text: Export greet that returns hello
    blockedBy: []
    allowedGlobs:
      - "src/**"
      - "tests/**"
    testSeams:
      - greet()
```

HITL tasks are rejected in v1.

## GitHub source

Set `github` in config and run:

```bash
agent-harness prepare --github 123
```

Issues labeled with `hitlLabel` are HITL; others default AFK when `afkLabel` is present or absent. Acceptance criteria are parsed from an `## Acceptance criteria` section.

## Recovery

`resume --run-id <id>` verifies manifest hash, worktree, branch, and HEAD before continuing. It never silently skips completed accepted tasks.

## Credentials

Set `CURSOR_API_KEY` (real agents) and `GITHUB_TOKEN` (`--github` prepare / publish) in the project cwd `.env` or `.env.local`. The CLI loads these automatically; shell/CI values are not overridden. Never commit tokens.

## Extension ports

See [docs/roadmap.md](../../docs/roadmap.md) for deferred HITL triage, extra trackers, parallel tasks, auto-merge, and exact-code reproducibility.

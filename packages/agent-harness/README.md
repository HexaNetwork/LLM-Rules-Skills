# @hexanetwork/agent-harness

A single-user, local coordinator that durably carries an idea or ticket through clarification, specification, container provisioning, implementation, validation, and pull-request publication.

Requirements: Node 22.5+, Git, Docker, GitHub CLI, and `CURSOR_API_KEY`.

## Quick start

```sh
npm install
npm run build
agent-harness serve --open
```

That starts the coordinator and opens the **WebUI** at `http://127.0.0.1:8787`. Everything else happens there:

- verify Docker and build the neutral runner image
- register projects (repository path and default base branch)
- start runs (pick project, base branch, idea; optional fresh project)
- answer operator gates as the workflow progresses
- inspect timeline, sessions, usage, artifacts, and diagnostics
- retry or cancel blocked runs

See [`design.md`](./design.md) for architecture and [`docs/plans/lean-harness-rebuild.md`](../../docs/plans/lean-harness-rebuild.md) for the full rebuild specification.

## CLI (optional)

The CLI is a thin HTTP client plus two bootstrap commands. Normal operation does not require it.

| Command | Purpose |
| --- | --- |
| `agent-harness serve` | Start the coordinator and WebUI |
| `agent-harness reset-home` | Development-only: wipe the harness home |
| `agent-harness project …`, `start`, `status`, `answer`, `retry`, `cancel`, `publish` | Optional API shortcuts when the coordinator is already running |

## API

The WebUI uses the same HTTP/SSE API documented implicitly by `src/api-server.ts`. Run detail: `GET /api/runs/:id`. Per-run slices: `/activity`, `/sessions`, `/usage`, `/artifacts`. Global usage: `GET /api/telemetry`. Reported totals come from provider telemetry and are not estimates.

Configuration lives in `<harness-home>/config.json`; see the exported `EffectiveConfig` type for supported values.

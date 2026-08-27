# @hexanetwork/agent-harness

A single-user, local coordinator that durably carries an idea or ticket through clarification, specification, container provisioning, implementation, validation, and pull-request publication.

Requirements: Node 22.5+, Git, Docker, GitHub CLI, and `CURSOR_API_KEY`.

```sh
npm install
npm run build
agent-harness serve
```

Use the WebUI for Docker/image setup, project registration, and run creation. The following commands remain optional API-client equivalents; every client command talks to the running coordinator and returns immediately for long-running work.

```sh
agent-harness project add --name example --repository /path/to/repo --base-branch main
agent-harness project list
agent-harness start --project PROJECT_ID --idea "Add the requested capability"
agent-harness status --run-id RUN_ID
```

Open `http://127.0.0.1:8787`. The Docker setup panel verifies the host daemon and builds or rebuilds the neutral runner image, so image setup, project registration, and run creation can all be completed in the WebUI. The UI also provides operator gates, live activity, provider token and cost telemetry, agent-session details, step outputs, artifacts, and diagnostics, and updates over SSE while work is active.

Run detail is also available to local API clients at `/api/runs/:id`. Compatibility endpoints expose `/activity`, `/sessions`, `/usage`, and `/artifacts` for that run, while `/api/telemetry` reports usage across all runs. Reported totals come from provider telemetry and are not estimates.

Configuration lives in `<harness-home>/config.json`; see the exported `EffectiveConfig` type for supported values.

# Agent Harness — installation

## Requirements

- Node.js 22.5+
- npm
- Git
- Docker with Linux containers
- GitHub CLI authenticated on the host for pull-request publication
- `CURSOR_API_KEY` in the coordinator environment

## Install and start

```bash
npm install
npm run build
npx agent-harness serve
```

For day-to-day use on Windows, double-click
`scripts\Launch-AgentHarness.cmd`. It starts the coordinator and opens the Web
UI. `npm start` is the cross-platform equivalent.

Keep the coordinator running and use the dashboard for setup and operation. The
following commands remain optional API-client equivalents:

```bash
npx agent-harness project add --name example --repository "/path/to/project" --base-branch main
npx agent-harness project list
npx agent-harness start --project PROJECT_ID --idea "Add a health check"
```

The dashboard is served at `http://127.0.0.1:8787`. Its **Docker & runner
image** panel checks Docker readiness and builds or rebuilds the neutral runner
image. Image setup, project registration, and run creation are all available in
the WebUI; the commands above are optional CLI equivalents. Docker itself must
already be installed and running because a browser cannot safely install or
start the host container daemon. For a development-only clean slate, stop the
coordinator and run `npx agent-harness reset-home`.

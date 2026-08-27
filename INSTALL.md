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
npx agent-harness install-runner
npx agent-harness serve
```

Keep the coordinator running. In another shell:

```bash
npx agent-harness project add --name example --repository "/path/to/project" --base-branch main
npx agent-harness project list
npx agent-harness start --project PROJECT_ID --idea "Add a health check"
```

The dashboard is served at `http://127.0.0.1:8787`. The CLI exits with a clear
error when the coordinator is not running. For a development-only clean slate,
stop the coordinator and run `npx agent-harness reset-home`.

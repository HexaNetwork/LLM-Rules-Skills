# Agent Harness — Installation

The Windows experience is a guided launcher. You do not need to remember the
CLI sequence for normal setup or day-to-day use.

**Primary entry point (recommended on Windows):** double-click:

```text
scripts\Launch-AgentHarness.cmd
```

The launcher presents four choices:

1. **Open dashboard** — update/build, register the project if needed, open the browser.
2. **Register a project** — `project add` against a chosen repository.
3. **Check Docker** — Linux-container readiness only. Not a launch gate.
4. **Inspect host composition** — `agent-harness dump-config`.

```powershell
.\scripts\launch-agent-harness.ps1
.\scripts\launch-agent-harness.ps1 -Action Setup
```

```bash
bash scripts/launch-agent-harness.sh /path/to/your-project
```

## Requirements

- **Node.js 20.3+**
- **npm**
- **Git**
- **Docker** (Linux containers) for isolated agent execution. Fake-agent
  workflows and `dump-config` do not need Docker.
- Optional: **`CURSOR_API_KEY`** in the environment for live Cursor. The key is
  passed into the run container. There is no provider proxy or proof-tuple
  launch gate.
- Optional: **`GITHUB_TOKEN`** on the host for push/PR. It never enters the
  container.

## Manual path

```bash
npm install
npm run build
npx agent-harness dump-config
npx agent-harness project add --repository "/path/to/your-project"
npx agent-harness start --idea "Add a health check" --repository "/path/to/your-project"
npx agent-harness ui --repository "/path/to/your-project"
```

See [the package guide](packages/agent-harness/README.md).

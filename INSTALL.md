# Agent Harness — Installation

Install Node, build this checkout, then deploy the harness into a target project folder.

**Interactive wizard (recommended on Windows):** double-click or run from this checkout:

```text
scripts\Install-AgentHarness.cmd
```

That opens PowerShell with `-ExecutionPolicy Bypass` and runs `scripts\install-agent-harness.ps1`. It walks through Node, build, Cursor API key (stored as a Windows User environment variable — not `.env`), deploy options, and the dashboard.

Alternatives:

```powershell
.\scripts\install-agent-harness.ps1
```

```bash
bash scripts/install-agent-harness.sh
```

Manual steps below match the same flow.

## Requirements

- **Node.js 20.3+** (required; there is no non-Node CLI)
- **npm** (comes with Node)
- **Cursor API key** for real agent runs (`CURSOR_API_KEY`)
- Optional: **Ollama** for local embeddings, **uv**/**pipx** for Graphify

## 1. Install Node (if needed)

Windows:

```powershell
winget install OpenJS.NodeJS.LTS
```

Confirm:

```powershell
node -v   # v20.3 or newer
npm -v
```

Open a **new** terminal after installing so `node` is on `PATH`.

### PowerShell blocks `npm` (ExecutionPolicy)

If you see `npm.ps1 cannot be loaded because running scripts is disabled`, use one of these:

**Option A — allow scripts for your user (recommended once):**

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Close and reopen the terminal, then use `npm` as usual.

**Option B — bypass for this session only:**

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

**Option C — call npm without the `.ps1` shim:**

```powershell
npm.cmd install
npm.cmd run build
```

Or use **Command Prompt** (`cmd.exe`) instead of PowerShell. The `.cmd` install/launch wrappers already bypass script policy for the wizard scripts.

## 2. Get this repo and build

Clone or copy the repo, then from its root:

```powershell
cd "C:\path\to\LLM-Rules-Skills"
npm install
npm run build
```

This creates `packages/agent-harness/dist/cli.js`. If that file is missing, deploy will fail with `MODULE_NOT_FOUND`.

## 3. Set the Cursor API key

Current PowerShell session:

```powershell
$env:CURSOR_API_KEY = "your-key-here"
```

Persist for your Windows user (new terminals pick it up):

```powershell
[System.Environment]::SetEnvironmentVariable("CURSOR_API_KEY", "your-key-here", "User")
```

Restart any running harness/`ui` process after changing the key. The install wizard can set the User env variable for you — it never writes the key to `.env`.

## 4. Register a project

```powershell
node "C:\path\to\LLM-Rules-Skills\packages\agent-harness\dist\cli.js" project add `
  --repository "C:\path\to\your-project"
```

This seeds shared guidance under harness home and does not write guidance or setup scripts into the target. For structural code retrieval:

```powershell
uv tool install graphifyy
```

Or write a repo-local config with `deploy` (does **not** open the dashboard — that is a separate `ui` step):

```powershell
node "C:\path\to\LLM-Rules-Skills\packages\agent-harness\dist\cli.js" deploy `
  --project "C:\path\to\your-project" `
  --ollama --refresh
```

Useful deploy flags: `--force`, `--sources a,b`, `--no-graphify`.

## 5. Start the dashboard

**Launcher (pull + rebuild + ui):** double-click or run:

```text
scripts\Launch-AgentHarness.cmd
```

If you omit the project path, the launcher offers remembered projects (from user settings) or prompts for a path. Scripted use:

```powershell
.\scripts\launch-agent-harness.ps1 -Project "C:\path\to\your-project"
```

```bash
bash scripts/launch-agent-harness.sh "/path/to/your-project"
```

Or set `AGENT_HARNESS_PROJECT` and omit the path. Use `--no-pull` / `-NoPull` or `--no-build` / `-NoBuild` to skip steps (explicit flags always win over settings).

### User settings (machine defaults)

Launchers and the install wizard keep a small **user-local** preferences file outside the repo (so prefs never create a git diff in `LLM-Rules-Skills`):

| OS | Path |
| --- | --- |
| Windows | `%LOCALAPPDATA%\agent-harness\settings.json` |
| macOS / Linux | `${XDG_CONFIG_HOME:-$HOME/.config}/agent-harness/settings.json` |

Schema (defaults apply when keys are missing; first write creates the file with these values):

```json
{
  "version": 1,
  "lastProject": "C:\\path\\to\\project",
  "projects": [
    { "path": "C:\\path\\to\\project", "lastUsedAt": "2026-08-09T12:00:00.000Z" }
  ],
  "launch": {
    "pullOnStart": true,
    "buildOnStart": true
  },
  "ui": {
    "port": 8787,
    "openBrowser": true
  }
}
```

| Concern | Where |
| --- | --- |
| Remembered projects, last project, launch/UI machine defaults | User `settings.json` |
| Per-project harness policy | Project’s `agent-harness.config.yaml` |
| Secrets (`CURSOR_API_KEY`) | Windows User env / shell profile only — **never** in `settings.json` |

**Project path resolution** when starting the dashboard:

1. Explicit `-Project` / positional path
2. `AGENT_HARNESS_PROJECT` (scripting override only)
3. Current directory if it already has `agent-harness.config.yaml`
4. Interactive picker from remembered projects that still have that config (default highlight = `lastProject`); option to type a new path
5. If the list is empty, prompt for a path

**Launch / UI knobs:** explicit launcher flags → values from `settings.json` → built-in defaults (`pull`/`build` on, port `8787`, open browser on). The launcher passes `--port` and `--no-open` to `agent-harness ui` from `ui.*` settings. A successful install wizard deploy seeds the remembered project list.

**Manual:** from the **target project** (the folder with `agent-harness.config.yaml`):

```powershell
cd "C:\path\to\your-project"
node "C:\path\to\LLM-Rules-Skills\packages\agent-harness\dist\cli.js" ui
```

The process prints a loopback URL with a one-time access token, for example:

`http://127.0.0.1:<port>/?token=...`

Open that exact URL. The token is generated at startup and is only valid for that UI process.

## 6. Optional: Graphify and Ollama

Graphify (structural code retrieval), after deploy:

```powershell
node "C:\path\to\LLM-Rules-Skills\packages\agent-harness\dist\cli.js" graphify install `
  --project "C:\path\to\your-project"
```

Add `--install-prerequisite` if neither `uv` nor `pipx` is installed.

Local embeddings setup scripts live under `packages/agent-harness/scripts/` (`setup-local-embeddings.ps1` / `.sh`).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Cannot find module ...\dist\cli.js` | Run `npm install` and `npm run build` in the **LLM-Rules-Skills** checkout |
| `node` / `npm` not recognized | Install Node 20.3+, then open a new terminal |
| `npm.ps1 cannot be loaded` / ExecutionPolicy | Use `scripts\Install-AgentHarness.cmd`, or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or `npm.cmd` |
| Dashboard access denied / `Invalid or missing dashboard token` | Close the tab, copy the **full** URL printed by the current `ui` process (including `?token=...`), and open that. Restarting `ui` invalidates the old token; an old tab or a bookmark without `?token=` will fail on Start reflect. |
| Agent backend / missing API key | Set `CURSOR_API_KEY` in the same environment that runs the harness, then restart `ui` |
| Config already exists | Redeploy with `--force`, or edit the existing `agent-harness.config.yaml` |
| `not a git repository` / `git status failed (128)` on Start reflect | The target folder is not a git repo but `git.enabled` is true (deploy default). The install wizard auto-inits git and commits after deploy; for a manual deploy, either `git init` + initial commit, or set `git.enabled: false` in `agent-harness.config.yaml` |

## More detail

See [packages/agent-harness/README.md](packages/agent-harness/README.md) for commands, lifecycle, knowledge, and configuration.

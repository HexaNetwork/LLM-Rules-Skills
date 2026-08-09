# Agent Harness — Installation

Install Node, build this checkout, then deploy the harness into a target project folder.

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

Or use **Command Prompt** (`cmd.exe`) instead of PowerShell.

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

Restart any running harness/`ui` process after changing the key.

## 4. Deploy into a project folder

`deploy` installs config into the target project. It does **not** open a browser or start the dashboard — that is a separate `ui` step below.

Works from any working directory (use absolute paths):

```powershell
node "C:\path\to\LLM-Rules-Skills\packages\agent-harness\dist\cli.js" deploy `
  --project "C:\path\to\your-project" `
  --ollama --refresh
```

Success looks like console lines such as `Deployed harness config to ...` and `Indexed N changed document(s)`, then the command exits. Check that the target project now has `agent-harness.config.yaml` and `.agent-harness/`.

What this does:

- writes `agent-harness.config.yaml` in the target project
- creates `.agent-harness/` and adds it to `.gitignore`
- detects common doc roots (override with `--sources README.md,docs`)
- optionally configures Ollama embeddings and builds the first knowledge index (`--ollama --refresh`)

Useful flags:

| Flag | Purpose |
| --- | --- |
| `--force` | replace an existing config |
| `--sources a,b` | override knowledge source paths |
| `--install-graphify` | run Graphify setup in the target project |
| `--install-graphify-prerequisite` | allow installing `uv` if needed |
| `--no-graphify` | document-only; skip structural code retrieval |

## 5. Start the dashboard

From the **target project** (the folder with `agent-harness.config.yaml`):

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
| `npm.ps1 cannot be loaded` / ExecutionPolicy | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use `npm.cmd`, or run from `cmd.exe` |
| Dashboard access denied / `Invalid or missing dashboard token` | Close the tab, copy the **full** URL printed by the current `ui` process (including `?token=...`), and open that. Restarting `ui` invalidates the old token; an old tab or a bookmark without `?token=` will fail on Start reflect. |
| Agent backend / missing API key | Set `CURSOR_API_KEY` in the same environment that runs the harness, then restart `ui` |
| Config already exists | Redeploy with `--force`, or edit the existing `agent-harness.config.yaml` |

## More detail

See [packages/agent-harness/README.md](packages/agent-harness/README.md) for commands, lifecycle, knowledge, and configuration.

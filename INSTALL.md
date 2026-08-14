# Agent Harness — Installation

The Windows experience is guided and Docker-only. You do not need to remember
the CLI sequence for normal setup or day-to-day use.

**Primary entry point (recommended on Windows):** double-click:

```text
scripts\Launch-AgentHarness.cmd
```

The launcher presents four choices:

1. **Open dashboard** — update/build, check Docker and the maintained worker, then open the browser.
2. **Set up or repair a project** — run the full guided setup.
3. **Check Docker and worker readiness** — show actionable blockers without starting the dashboard.
4. **Inspect trusted vNext composition** — render the host and worker Cordis profiles.

For a first install, choice 2 checks Node, WSL2/Docker Desktop on Windows,
registers the project with `project add`, runs
`execution prepare-worker --force-rebuild --write-settings`, verifies readiness,
and offers optional repository-intelligence tools. It never installs Docker
Desktop silently and never writes secrets to `.env`.

The setup-only shortcut remains available:

```text
scripts\Install-AgentHarness.cmd
```

Alternatives:

```powershell
.\scripts\launch-agent-harness.ps1
.\scripts\launch-agent-harness.ps1 -Action Setup
```

```bash
bash scripts/install-agent-harness.sh
```

Manual steps below match the same flow.

## Requirements

- **Node.js 20.3+** (required; there is no non-Node CLI)
- **npm** (comes with Node)
- **Cursor API key** (`CURSOR_API_KEY`) for real agent runs once credential mounting clears its isolation release gate; the dashboard and deterministic readiness checks do not require it
- **Windows only:** **WSL2** for the Docker Desktop Linux-container backend
- **Docker** (required; Linux containers). The install wizard detects `docker info`, Linux container mode, and daemon permissions; if Desktop is installed but stopped it may ask to start it and wait for the daemon. It prepares the maintained worker image after the package build. It does **not** silently install Docker Desktop.
- Optional: **Ollama** for local embeddings; **GitNexus** (`npm install -g gitnexus`, PolyForm Noncommercial — see below); **CodeGraph** (`npm install -g @colbymchenry/codegraph`)

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

This creates `packages/agent-harness/dist/cli.js`. If that file is missing, registration will fail with `MODULE_NOT_FOUND`.

## 3. Optionally set the Cursor API key

The setup wizard can save this as a Windows User environment variable. The
dashboard can be explored without it. Real Cursor-in-Docker execution remains
fail-closed while the credential-isolation smoke gate is unresolved; having a
key does not bypass that gate.

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

This seeds shared guidance under harness home and does not write guidance or setup scripts into the target.

The interactive wizard stage **Repository intelligence** asks about both providers.

**GitNexus (primary)** — before installing, the wizard warns that GitNexus uses the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/). Free for noncommercial / personal use; commercial use of the OSS package needs a separate license from [Akon Labs](https://akonlabs.com) (`founders@akonlabs.com`). Upstream: [abhigyanpatwari/GitNexus](https://github.com/abhigyanpatwari/GitNexus). Answering **y** confirms you understand those terms and runs `npm install -g gitnexus` (or reports that it is already installed).

**CodeGraph (fallback)** — **y** runs `npm install -g @colbymchenry/codegraph` (or reports that it is already installed). **n** skips.

`init` / `deploy` still only write config/gitignore; they do not install either CLI. Manual:

```powershell
npm install -g gitnexus                 # primary — check PolyForm Noncommercial first
npm install -g @colbymchenry/codegraph  # fallback
```

Or write a repo-local config with `deploy` (does **not** open the dashboard — that is a separate `ui` step):

```powershell
node "C:\path\to\LLM-Rules-Skills\packages\agent-harness\dist\cli.js" deploy `
  --project "C:\path\to\your-project" `
  --ollama --refresh
```

Useful deploy flags: `--force`, `--sources a,b`, `--no-codegraph`.

## 5. Start the dashboard

**Normal launch:** double-click:

```text
scripts\Launch-AgentHarness.cmd
```

Choose **Open dashboard**. The launcher uses the last remembered project by
default, updates and builds the checkout, starts Docker Desktop when it is
already installed but stopped, checks the worker image/isolation probe, and
opens the authenticated dashboard. If the worker is stale or missing, it offers
to repair it in place.

Scripted/advanced use remains available:

```powershell
.\scripts\launch-agent-harness.ps1 -Action Dashboard -Project "C:\path\to\your-project"
.\scripts\launch-agent-harness.ps1 -Action Check -Project "C:\path\to\your-project"
.\scripts\launch-agent-harness.ps1 -Action Config
```

```bash
bash scripts/launch-agent-harness.sh "/path/to/your-project"
```

Or set `AGENT_HARNESS_PROJECT` and omit the path. Use `--no-pull` /
`-NoPull` or `--no-build` / `-NoBuild` to skip update/build steps (explicit
flags always win over settings).

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
| Per-project harness policy | Harness-home project `config.yaml` |
| Secrets (`CURSOR_API_KEY`) | Windows User env / shell profile only — **never** in `settings.json` |

**Project path resolution** when starting the dashboard:

1. Explicit `-Project` / positional path
2. `AGENT_HARNESS_PROJECT` (scripting override only)
3. Current directory
4. Interactive picker from remembered projects that still exist (default highlight = `lastProject`); option to type a new path
5. If the list is empty, prompt for a path

**Launch / UI knobs:** explicit launcher flags → values from `settings.json`
→ built-in defaults (`pull`/`build` on, port `8787`, open browser on). A
successful setup registration seeds the remembered project list.

**Manual:** against a registered repository:

```powershell
node "C:\path\to\LLM-Rules-Skills\packages\agent-harness\dist\cli.js" ui `
  --repository "C:\path\to\your-project"
```

The process prints a loopback URL with a one-time access token, for example:

`http://127.0.0.1:<port>/?token=...`

Open that exact URL. The token is generated at startup and is only valid for that UI process.

## 6. Optional: GitNexus, CodeGraph, and Ollama

The install wizard can install GitNexus and/or CodeGraph when you answer **y**. GitNexus prompts include a PolyForm Noncommercial license warning first. If you skipped those prompts, or you are following the manual steps:

```powershell
npm install -g gitnexus                 # primary — PolyForm Noncommercial; commercial use needs a separate license
npm install -g @colbymchenry/codegraph  # fallback
```

On Windows, global npm binaries often land in `%AppData%\Roaming\npm` — add that directory to User PATH if `gitnexus --version` / `codegraph --version` fails in a new terminal.

Local embeddings setup scripts live under `packages/agent-harness/scripts/` (`setup-local-embeddings.ps1` / `.sh`). Enable embeddings in the harness-home project config when ready.

## 7. Docker runtime

Docker is the only production execution runtime. Local linked worktrees and generated per-run images are retired; old active runs must be finished, exported, or discarded before cutover.

1. Install Docker yourself (Docker Desktop on Windows with **WSL2 + Linux containers**, or a Linux/macOS daemon with permission to run `docker info`). The install wizard never silently installs Docker Desktop; on Windows it may offer to **start** Desktop if the CLI is present but the daemon is down.
2. Double-click `scripts\Launch-AgentHarness.cmd`, then choose **Set up or repair a project**. It performs `project add`, rebuilds the one maintained worker with `--force-rebuild --write-settings`, and runs the isolation probe.
3. Use launcher choice **Check Docker and worker readiness** whenever you want a readable readiness report without opening the dashboard.
4. Expect disk/CPU/memory cost for the shared image and named volumes. Bridge networking is filesystem isolation, **not** egress-proof.

Launch is fail-closed: if Docker, the maintained worker, or its isolation probe
is not ready, the dashboard launcher stops or offers repair instead of implying
that local execution is available. Real Cursor secrets are also fail-closed
until the credential-gated isolation smoke test passes.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Cannot find module ...\dist\cli.js` | Run `npm install` and `npm run build` in the **LLM-Rules-Skills** checkout |
| `node` / `npm` not recognized | Install Node 20.3+, then open a new terminal |
| `npm.ps1 cannot be loaded` / ExecutionPolicy | Use `scripts\Install-AgentHarness.cmd`, or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or `npm.cmd` |
| Dashboard access denied / `Invalid or missing dashboard token` | Close the tab, copy the **full** URL printed by the current `ui` process (including `?token=...`), and open that. Restarting `ui` invalidates the old token; an old tab or a bookmark without `?token=` will fail on Start reflect. |
| Agent backend / missing API key | The dashboard still opens. For real runs, set `CURSOR_API_KEY` and restart `ui`; credential mounting remains blocked until the isolation release gate passes. |
| Leftover `agent-harness.config.yaml` / `.agent-harness/` in the target | Pre-cutover repo-local state is unsupported. Archive or remove it after confirming the external project registration. |
| `not a git repository` / `git status failed (128)` on Start reflect | The target folder is not a git repo but `git.enabled` is true. The install wizard auto-inits git and commits after registration; otherwise `git init` + initial commit, or set `git.enabled: false` in the harness-home project config |

## More detail

See [packages/agent-harness/README.md](packages/agent-harness/README.md) for commands, lifecycle, knowledge, and configuration.

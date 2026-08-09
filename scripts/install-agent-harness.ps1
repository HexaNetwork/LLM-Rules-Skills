#Requires -Version 5.1
<#
.SYNOPSIS
  Interactive installation wizard for the Agent Harness (Windows).

.DESCRIPTION
  Walks through Node check, build, CURSOR_API_KEY (Windows User env - never .env),
  target project, optional Ollama/Graphify, deploy, and optional dashboard start.

.EXAMPLE
  .\scripts\install-agent-harness.ps1

.EXAMPLE
  .\scripts\Install-AgentHarness.cmd
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Wizard helpers
# ---------------------------------------------------------------------------

$script:TOTAL_STAGES = 8
$script:STAGE_INDEX = 0
$script:SKIPPED = [System.Collections.Generic.List[string]]::new()
$script:WRITTEN_USER_ENV = [System.Collections.Generic.List[string]]::new()

function Test-IsInteractiveHost {
  try {
    return [bool]$Host.UI.RawUI -and -not [Console]::IsOutputRedirected
  } catch {
    return $false
  }
}

function Clear-WizardScreen {
  if (-not (Test-IsInteractiveHost)) { return }
  try { Clear-Host } catch { }
}

function Write-Banner {
  param([string]$Title)
  Clear-WizardScreen
  Write-Host ""
  Write-Host ("  " + $Title) -ForegroundColor Cyan
  Write-Host ("  $($script:TOTAL_STAGES) stages") -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  You drive the browser; this wizard tells you exactly what to do and" -ForegroundColor DarkGray
  Write-Host "  captures the values you copy back. Stop any time with Ctrl-C and re-run" -ForegroundColor DarkGray
  Write-Host "  later - it remembers values already saved." -ForegroundColor DarkGray
  Invoke-Pause "Ready to start?"
}

function Write-Stage {
  param([string]$Name)
  Clear-WizardScreen
  $script:STAGE_INDEX++
  Write-Host ""
  Write-Host ("> Stage $($script:STAGE_INDEX)/$($script:TOTAL_STAGES) - $Name") -ForegroundColor Cyan
}

function Write-Say { param([string]$Message) Write-Host ("  " + $Message) }
function Write-Step { param([string]$Message) Write-Host ("  * " + $Message) -ForegroundColor Blue }
function Write-Note { param([string]$Message) Write-Host ("  " + $Message) -ForegroundColor DarkGray }
function Write-WarnLine { param([string]$Message) Write-Host ("  ! " + $Message) -ForegroundColor Yellow }
function Write-Ok { param([string]$Message) Write-Host ("  OK " + $Message) -ForegroundColor Green }

function Open-Url {
  param([string]$Url)
  Write-Host ("  -> opening " + $Url) -ForegroundColor Green
  try {
    Start-Process $Url | Out-Null
  } catch {
    Write-WarnLine "couldn't open a browser - visit it manually: $Url"
  }
}

function Invoke-Pause {
  param([string]$Message = "Press Enter to continue")
  Write-Host ("  " + $Message + " ") -ForegroundColor DarkGray -NoNewline
  [void](Read-Host)
}

function Confirm-Yes {
  param([string]$Question)
  Write-Host ("  ? " + $Question + " [y/N] ") -ForegroundColor Yellow -NoNewline
  $reply = Read-Host
  return ($reply -match '^[Yy]')
}

function Read-Ask {
  param(
    [string]$Prompt,
    [string]$Default = ""
  )
  if (-not [string]::IsNullOrWhiteSpace($Default)) {
    Write-Host ("  " + $Prompt + " ") -NoNewline
    Write-Host "[Enter keeps current] " -ForegroundColor DarkGray -NoNewline
  } else {
    Write-Host ("  " + $Prompt + " ") -NoNewline
  }
  $value = Read-Host
  if ([string]::IsNullOrWhiteSpace($value) -and -not [string]::IsNullOrWhiteSpace($Default)) {
    return $Default
  }
  return $value
}

function Read-AskSecret {
  param(
    [string]$Prompt,
    [string]$Default = ""
  )
  if (-not [string]::IsNullOrWhiteSpace($Default)) {
    Write-Host ("  " + $Prompt + " ") -NoNewline
    Write-Host "[Enter keeps current] " -ForegroundColor DarkGray -NoNewline
  } else {
    Write-Host ("  " + $Prompt + " ") -NoNewline
  }
  $secure = Read-Host -AsSecureString
  if ($null -eq $secure) { return $Default }
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) | Out-Null
  }
  if ([string]::IsNullOrWhiteSpace($plain) -and -not [string]::IsNullOrWhiteSpace($Default)) {
    return $Default
  }
  return $plain
}

function Test-NodeOk {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { return $false }
  try {
    $js = @'
const [M,m]=process.versions.node.split('.').map(Number);
process.stdout.write((M>20||(M===20&&m>=3))?'ok':'bad');
'@
    $ver = & node -e $js 2>$null
    return ($ver -eq 'ok')
  } catch {
    return $false
  }
}

function Get-WindowsUserEnv {
  param([string]$Name)
  return [Environment]::GetEnvironmentVariable($Name, "User")
}

function Set-WindowsUserEnv {
  param(
    [string]$Name,
    [string]$Value
  )
  [Environment]::SetEnvironmentVariable($Name, $Value, "User")
  $script:WRITTEN_USER_ENV.Add($Name) | Out-Null
  Write-Ok "set Windows User environment variable $Name"
}

function Write-Finish {
  Clear-WizardScreen
  Write-Host ""
  Write-Host "  OK Setup complete" -ForegroundColor Green
  if ($script:WRITTEN_USER_ENV.Count -gt 0) {
    Write-Note ("set Windows User env: " + ($script:WRITTEN_USER_ENV -join ", "))
  }
  if ($script:SKIPPED.Count -gt 0) {
    Write-Host ""
    Write-WarnLine "still to do by hand:"
    foreach ($s in $script:SKIPPED) {
      Write-Note ("  - " + $s)
    }
  }
  Write-Host ""
}

# ---------------------------------------------------------------------------
# STAGES
# ---------------------------------------------------------------------------

$DefaultHarnessRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$CliRel = "packages\agent-harness\dist\cli.js"

Write-Banner "Agent Harness - installation"

# -- 1. Node prerequisites -------------------------------------------------
Write-Stage "Node prerequisites"
Write-Say "The harness CLI needs Node.js 20.3+ and npm."
if (Test-NodeOk) {
  $nodeVer = (& node -v 2>$null)
  $npmVer = (& npm.cmd -v 2>$null)
  if (-not $npmVer) { $npmVer = "?" }
  Write-Note "Found $nodeVer and npm $npmVer"
} else {
  Write-WarnLine "Node.js 20.3+ is missing or too old."
  Write-Step "Install with WinGet (recommended), or use the Node download page."
  Write-Note "winget install OpenJS.NodeJS.LTS"
  if (Confirm-Yes "Open the Node.js download page in your browser?") {
    Open-Url "https://nodejs.org/en/download"
  }
  Write-Say "After installing, close this terminal and re-run the wizard so PATH updates."
  Invoke-Pause "Press Enter once node -v shows v20.3 or newer"
  if (-not (Test-NodeOk)) {
    Write-WarnLine "Still no usable Node - fix PATH / install, then re-run this wizard."
    exit 1
  }
}
Write-Note "If PowerShell blocks npm.ps1 (ExecutionPolicy), run once:"
Write-Note "  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned"
Write-Note "Or use npm.cmd / Command Prompt instead."
Invoke-Pause "Continue to build the harness checkout?"

# -- 2. Build this checkout ------------------------------------------------
Write-Stage "Build this checkout"
Write-Say "We'll install dependencies and build packages/agent-harness."
$HarnessRoot = Read-Ask "Path to the LLM-Rules-Skills checkout:" $DefaultHarnessRoot
if ([string]::IsNullOrWhiteSpace($HarnessRoot)) {
  $HarnessRoot = $DefaultHarnessRoot
}
$HarnessRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($HarnessRoot)
if (-not (Test-Path -LiteralPath (Join-Path $HarnessRoot "package.json")) -or
    -not (Test-Path -LiteralPath (Join-Path $HarnessRoot "packages\agent-harness"))) {
  Write-WarnLine "That path does not look like this repo (missing package.json or packages/agent-harness)."
  exit 1
}
$Cli = Join-Path $HarnessRoot $CliRel
Write-Say "Running npm install and npm run build in:"
Write-Note $HarnessRoot
Push-Location -LiteralPath $HarnessRoot
try {
  & npm.cmd install
  if ($LASTEXITCODE -ne 0) {
    Write-Host "npm install failed (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
  }
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) {
    Write-Host "npm run build failed (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
  }
} finally {
  Pop-Location
}
if (-not (Test-Path -LiteralPath $Cli)) {
  Write-WarnLine "Build finished but $Cli is missing - deploy will fail."
  exit 1
}
Write-Ok "built $Cli"
Invoke-Pause "Continue to the Cursor API key?"

# -- 3. Cursor API key (Windows User env - never .env) ---------------------
Write-Stage "Cursor API key"
Write-Say "Real agent runs need CURSOR_API_KEY. We store it as a Windows User"
Write-Say "environment variable (not in .env / not in the repo)."
$ExistingKey = $env:CURSOR_API_KEY
if ([string]::IsNullOrWhiteSpace($ExistingKey)) {
  $ExistingKey = Get-WindowsUserEnv "CURSOR_API_KEY"
}
$KeepKey = $false
$CursorApiKey = $null
if (-not [string]::IsNullOrWhiteSpace($ExistingKey)) {
  Write-Note "A CURSOR_API_KEY is already available in this environment (or User env)."
  if (Confirm-Yes "Keep the existing key?") {
    $CursorApiKey = $ExistingKey
    $KeepKey = $true
  }
}
if (-not $KeepKey) {
  Open-Url "https://cursor.com/dashboard/api"
  Write-Step "Sign in to the Cursor Dashboard if prompted."
  Write-Step "Open API Keys (Dashboard -> API Keys)."
  Write-Step "Create a user API key, then copy it immediately (it may not be shown again)."
  $CursorApiKey = Read-AskSecret "Paste the Cursor API key:"
  if ([string]::IsNullOrWhiteSpace($CursorApiKey)) {
    Write-WarnLine "No key pasted - agent runs will fail until CURSOR_API_KEY is set."
    $script:SKIPPED.Add("CURSOR_API_KEY") | Out-Null
  }
}
if (-not [string]::IsNullOrWhiteSpace($CursorApiKey)) {
  $env:CURSOR_API_KEY = $CursorApiKey
  if (Confirm-Yes "Persist CURSOR_API_KEY to your Windows User environment?") {
    Set-WindowsUserEnv -Name "CURSOR_API_KEY" -Value $CursorApiKey
    Write-Note "New terminals pick it up automatically. Restart any running harness/ui after changes."
  } else {
    Write-Note "Key exported for this wizard session only."
    $script:SKIPPED.Add("persist CURSOR_API_KEY to Windows User env") | Out-Null
  }
}
Invoke-Pause "Continue to choose the target project?"

# -- 4. Target project -----------------------------------------------------
Write-Stage "Target project"
Write-Say "Deploy writes agent-harness.config.yaml and .agent-harness/ into a project folder."
$ProjectPath = Read-Ask "Absolute path to the target project:"
if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
  Write-WarnLine "A project path is required."
  exit 1
}
$ProjectPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ProjectPath)
if (-not (Test-Path -LiteralPath $ProjectPath)) {
  if (Confirm-Yes "Directory does not exist. Create it?") {
    New-Item -ItemType Directory -Path $ProjectPath -Force | Out-Null
  } else {
    exit 1
  }
}
Write-Note "Project: $ProjectPath"
# Deploy defaults to git.enabled: true; Start reflect needs a real git repo.
$script:InitializedGitRepo = $false
$GitCmd = Get-Command git -ErrorAction SilentlyContinue
$GitDir = Join-Path $ProjectPath ".git"
if (Test-Path -LiteralPath $GitDir) {
  Write-Note "Git repository already present."
} elseif (-not $GitCmd) {
  Write-WarnLine "git is not on PATH - cannot initialize a repository."
  Write-Note "Install git, or set git.enabled: false in agent-harness.config.yaml after deploy."
  $script:SKIPPED.Add("git repository (git not installed)") | Out-Null
} else {
  Write-Say "No .git found - initializing a git repository (required for harness runs)."
  Push-Location -LiteralPath $ProjectPath
  try {
    & git init -b main 2>$null
    if ($LASTEXITCODE -ne 0) {
      & git init
    }
    if ($LASTEXITCODE -ne 0) {
      Write-WarnLine "git init failed - fix manually or set git.enabled: false after deploy."
      $script:SKIPPED.Add("git init in target project") | Out-Null
    } else {
      $script:InitializedGitRepo = $true
      Write-Ok "initialized git repository (will commit after deploy so the tree is clean)"
    }
  } finally {
    Pop-Location
  }
}
Invoke-Pause "Continue to optional Ollama embeddings?"

# -- 5. Optional: Ollama ---------------------------------------------------
Write-Stage "Optional - Ollama embeddings"
Write-Say "Ollama provides local embeddings (no cloud API key). Deploy can wire it with --ollama."
$UseOllama = $false
if (Confirm-Yes "Configure Ollama embeddings during deploy?") {
  $UseOllama = $true
  Write-Step "Install Ollama if needed (Windows: winget install Ollama.Ollama, or the download page)."
  if (Confirm-Yes "Open the Ollama download page?") {
    Open-Url "https://ollama.com/download"
  }
  Write-Note "Optional helper after install:"
  Write-Note ("  " + (Join-Path $HarnessRoot "packages\agent-harness\scripts\setup-local-embeddings.ps1") + " -InstallOllama")
  Invoke-Pause "Press Enter once Ollama is installed (or skip and install later)"
}

# -- 6. Optional: Graphify -------------------------------------------------
Write-Stage "Optional - Graphify"
Write-Say "Graphify adds structural code retrieval. Default deploy enables it;"
Write-Say "you can skip with --no-graphify or install tooling now."
$UseGraphify = $true
$InstallGraphify = $false
$InstallUv = $false
if (Confirm-Yes "Enable Graphify for this project?") {
  if (Confirm-Yes 'Run Graphify setup during deploy (--install-graphify)?') {
    $InstallGraphify = $true
    if (Confirm-Yes 'Allow installing uv if missing (--install-graphify-prerequisite)?') {
      $InstallUv = $true
    }
  }
} else {
  $UseGraphify = $false
}

# -- 7. Deploy -------------------------------------------------------------
Write-Stage "Deploy into the project"
$DeployArgs = [System.Collections.Generic.List[string]]::new()
$DeployArgs.AddRange([string[]]@("deploy", "--project", $ProjectPath, "--refresh"))
if ($UseOllama) { $DeployArgs.Add("--ollama") | Out-Null }
if (-not $UseGraphify) {
  $DeployArgs.Add("--no-graphify") | Out-Null
} else {
  if ($InstallGraphify) { $DeployArgs.Add("--install-graphify") | Out-Null }
  if ($InstallUv) { $DeployArgs.Add("--install-graphify-prerequisite") | Out-Null }
}

$RunDeploy = $true
$configPath = Join-Path $ProjectPath "agent-harness.config.yaml"
if (Test-Path -LiteralPath $configPath) {
  Write-WarnLine "agent-harness.config.yaml already exists in the target project."
  if (Confirm-Yes "Replace it with --force?") {
    $DeployArgs.Add("--force") | Out-Null
  } else {
    Write-WarnLine "Deploy aborted - existing config left unchanged."
    $script:SKIPPED.Add('deploy (config already exists; re-run with --force if needed)') | Out-Null
    Invoke-Pause "Continue to dashboard instructions?"
    $RunDeploy = $false
  }
}
if ($RunDeploy) {
  Write-Say "About to run:"
  Write-Note ('node "' + $Cli + '" ' + ($DeployArgs -join " "))
  if (-not (Confirm-Yes "Run deploy now?")) {
    Write-WarnLine "Skipped deploy."
    $script:SKIPPED.Add("deploy") | Out-Null
    $RunDeploy = $false
  }
}
if ($RunDeploy) {
  & node $Cli @DeployArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Host "deploy failed (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
  }
  Write-Ok "deploy finished"
  if ($script:InitializedGitRepo) {
    Push-Location -LiteralPath $ProjectPath
    try {
      # Local identity only if unset — avoids failing commit on machines without global git config.
      $email = (& git config --get user.email 2>$null)
      $name = (& git config --get user.name 2>$null)
      if ([string]::IsNullOrWhiteSpace($email)) {
        & git config user.email "agent-harness@localhost"
      }
      if ([string]::IsNullOrWhiteSpace($name)) {
        & git config user.name "Agent Harness"
      }
      & git add -A
      $porcelain = (& git status --porcelain 2>$null)
      if (-not [string]::IsNullOrWhiteSpace($porcelain)) {
        & git commit -m "chore: initial commit (agent-harness install)"
        if ($LASTEXITCODE -ne 0) {
          Write-WarnLine "initial git commit failed - commit manually before Start reflect."
          $script:SKIPPED.Add("initial git commit") | Out-Null
        } else {
          & git branch -M main 2>$null
          Write-Ok "created initial commit on main (working tree clean for Start reflect)"
        }
      } else {
        Write-Note "nothing to commit after deploy"
      }
    } finally {
      Pop-Location
    }
  }
}
Invoke-Pause "Continue to dashboard startup?"

# -- 8. Start dashboard ----------------------------------------------------
Write-Stage "Start dashboard"
Write-Say "The dashboard prints a loopback URL with a one-time access token."
Write-Say "Open that exact URL (token is only valid for that ui process)."
Write-Note ('cd "' + $ProjectPath + '"')
Write-Note ('node "' + $Cli + '" ui')
Write-Note "CURSOR_API_KEY must be set in the same environment that runs ui."
if ([string]::IsNullOrWhiteSpace($env:CURSOR_API_KEY)) {
  Write-WarnLine "CURSOR_API_KEY is not set in this shell - set it before starting ui."
}

Write-Finish

Write-Host "  Next: start the dashboard from the target project."
Write-Host ""
if ((Test-Path -LiteralPath $Cli) -and (Test-Path -LiteralPath $ProjectPath) -and
    (Confirm-Yes "Start the dashboard now in this terminal?")) {
  Set-Location -LiteralPath $ProjectPath
  & node $Cli ui
  exit $LASTEXITCODE
}

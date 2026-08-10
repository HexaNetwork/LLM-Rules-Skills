#Requires -Version 5.1
<#
.SYNOPSIS
  Interactive installation wizard for the Agent Harness (Windows).

.DESCRIPTION
  Lean walkthrough: Node check, build, CURSOR_API_KEY (Windows User env - never .env),
  target project registration (project add), and optional dashboard start.

.EXAMPLE
  .\scripts\install-agent-harness.ps1

.EXAMPLE
  .\scripts\Install-AgentHarness.cmd
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "lib\user-settings.ps1")

# ---------------------------------------------------------------------------
# Wizard helpers
# ---------------------------------------------------------------------------

$script:TOTAL_STAGES = 5
$script:STAGE_INDEX = 0
$script:SKIPPED = [System.Collections.Generic.List[string]]::new()
$script:WRITTEN_USER_ENV = [System.Collections.Generic.List[string]]::new()

function Write-Banner {
  param([string]$Title)
  Write-Host ""
  Write-Host ("  " + $Title) -ForegroundColor Cyan
  Write-Host ("  $($script:TOTAL_STAGES) stages") -ForegroundColor DarkGray
  Write-Host ""
}

function Write-Stage {
  param([string]$Name)
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

function Test-HarnessCheckout {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  return (Test-Path -LiteralPath (Join-Path $Path "package.json")) -and
    (Test-Path -LiteralPath (Join-Path $Path "packages\agent-harness"))
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
  Write-Ok "Found $nodeVer and npm $npmVer"
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

# -- 2. Build this checkout ------------------------------------------------
Write-Stage "Build this checkout"
$HarnessRoot = $DefaultHarnessRoot
# Skip asking when the script's parent checkout is already valid (includes LLM-Rules-Skills).
if (Test-HarnessCheckout $HarnessRoot) {
  Write-Note "Using checkout: $HarnessRoot"
} else {
  $HarnessRoot = Read-Ask "Path to the LLM-Rules-Skills checkout:" $DefaultHarnessRoot
  if ([string]::IsNullOrWhiteSpace($HarnessRoot)) {
    $HarnessRoot = $DefaultHarnessRoot
  }
  $HarnessRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($HarnessRoot)
  if (-not (Test-HarnessCheckout $HarnessRoot)) {
    Write-WarnLine "That path does not look like this repo (missing package.json or packages/agent-harness)."
    exit 1
  }
}
$Cli = Join-Path $HarnessRoot $CliRel
Write-Say "Running npm install and npm run build..."
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

# -- 3. Cursor API key (Windows User env - never .env) ---------------------
Write-Stage "Cursor API key"
Write-Say "Real agent runs need CURSOR_API_KEY (Windows User env, not .env)."
$ExistingKey = $env:CURSOR_API_KEY
if ([string]::IsNullOrWhiteSpace($ExistingKey)) {
  $ExistingKey = Get-WindowsUserEnv "CURSOR_API_KEY"
}
$CursorApiKey = $null
if (-not [string]::IsNullOrWhiteSpace($ExistingKey)) {
  Write-Ok "Using existing CURSOR_API_KEY"
  $CursorApiKey = $ExistingKey
  if (Confirm-Yes "Replace it with a new key?") {
    $CursorApiKey = $null
  }
}
if ([string]::IsNullOrWhiteSpace($CursorApiKey)) {
  Open-Url "https://cursor.com/dashboard/api"
  Write-Step "Create a user API key, then paste it here."
  $CursorApiKey = Read-AskSecret "Paste the Cursor API key:"
  if ([string]::IsNullOrWhiteSpace($CursorApiKey)) {
    Write-WarnLine "No key pasted - agent runs will fail until CURSOR_API_KEY is set."
    $script:SKIPPED.Add("CURSOR_API_KEY") | Out-Null
  }
}
if (-not [string]::IsNullOrWhiteSpace($CursorApiKey)) {
  $env:CURSOR_API_KEY = $CursorApiKey
  $userKey = Get-WindowsUserEnv "CURSOR_API_KEY"
  if ($userKey -ne $CursorApiKey) {
    Set-WindowsUserEnv -Name "CURSOR_API_KEY" -Value $CursorApiKey
    Write-Note "New terminals pick it up automatically. Restart any running harness/ui after changes."
  }
}

# -- 4. Target project + register ------------------------------------------
Write-Stage "Target project"
Write-Say "Registers the repo in harness home (config stays outside the project)."
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
$configPath = Join-Path $ProjectPath "agent-harness.config.yaml"
$statePath = Join-Path $ProjectPath ".agent-harness"
if ((Test-Path -LiteralPath $configPath) -or (Test-Path -LiteralPath $statePath)) {
  Write-WarnLine "Found leftover repo-local harness files (agent-harness.config.yaml and/or .agent-harness/)."
  Write-Note "Registration does not need them. Delete them after a successful project add, or run: agent-harness migrate-home"
}

$script:InitializedGitRepo = $false
$GitCmd = Get-Command git -ErrorAction SilentlyContinue
$GitDir = Join-Path $ProjectPath ".git"
if (Test-Path -LiteralPath $GitDir) {
  Write-Note "Git repository already present."
} elseif (-not $GitCmd) {
  Write-WarnLine "git is not on PATH - cannot initialize a repository."
  Write-Note "Install git, or set git.enabled: false in the harness-home project config."
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
      Write-WarnLine "git init failed - fix manually or set git.enabled: false in harness-home config."
      $script:SKIPPED.Add("git init in target project") | Out-Null
    } else {
      $script:InitializedGitRepo = $true
      Write-Ok "initialized git repository"
    }
  } finally {
    Pop-Location
  }
}

Write-Say "Registering project..."
& node $Cli project add --repository $ProjectPath
if ($LASTEXITCODE -ne 0) {
  Write-WarnLine "project add reported an error (exit $LASTEXITCODE)."
  Write-Note "If the repository is already registered, that is fine - continue."
  $script:SKIPPED.Add("project add (non-zero exit; may already be registered)") | Out-Null
} else {
  Write-Ok "project registered in harness home"
}
try {
  [void](Remember-AgentHarnessProject -Path $ProjectPath)
  Write-Note ("remembered project in " + (Get-AgentHarnessSettingsPath))
} catch {
  Write-WarnLine ("could not write user settings: " + $_.Exception.Message)
}
if ($script:InitializedGitRepo) {
  Push-Location -LiteralPath $ProjectPath
  try {
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
      & git commit -m "chore: initial commit"
      if ($LASTEXITCODE -ne 0) {
        Write-WarnLine "initial git commit failed - commit manually before Start reflect."
        $script:SKIPPED.Add("initial git commit") | Out-Null
      } else {
        & git branch -M main 2>$null
        Write-Ok "created initial commit on main"
      }
    } else {
      Write-Note "nothing to commit after registration"
    }
  } finally {
    Pop-Location
  }
}

Write-Note "Optional later: Ollama embeddings, and Graphify via: uv tool install graphifyy"

# -- 5. Start dashboard ----------------------------------------------------
Write-Stage "Start dashboard"
Write-Say "The dashboard prints a loopback URL with a one-time access token."
Write-Note ('node "' + $Cli + '" ui --repository "' + $ProjectPath + '"')
if ([string]::IsNullOrWhiteSpace($env:CURSOR_API_KEY)) {
  Write-WarnLine "CURSOR_API_KEY is not set in this shell - set it before starting ui."
}

Write-Finish

if ((Test-Path -LiteralPath $Cli) -and (Test-Path -LiteralPath $ProjectPath) -and
    (Confirm-Yes "Start the dashboard now in this terminal?")) {
  Set-Location -LiteralPath $ProjectPath
  & node $Cli ui --repository $ProjectPath
  exit $LASTEXITCODE
}

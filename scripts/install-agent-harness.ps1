#Requires -Version 5.1
<#
.SYNOPSIS
  Interactive installation wizard for the Agent Harness (Windows).

.DESCRIPTION
  Docker-only setup/repair walkthrough: Node and Docker checks, package build,
  project registration, maintained worker prepare/probe, optional repository
  intelligence providers, and dashboard launch. Docker Desktop may be started
  when already installed, but is never silently installed.

.EXAMPLE
  .\scripts\install-agent-harness.ps1

.EXAMPLE
  .\scripts\Install-AgentHarness.cmd
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "lib\user-settings.ps1")
. (Join-Path $PSScriptRoot "lib\docker-ready.ps1")

# ---------------------------------------------------------------------------
# Wizard helpers
# ---------------------------------------------------------------------------

$script:TOTAL_STAGES = 8
$script:STAGE_INDEX = 0
$script:SKIPPED = [System.Collections.Generic.List[string]]::new()
$script:WRITTEN_USER_ENV = [System.Collections.Generic.List[string]]::new()
$script:DockerDaemonReady = $false

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

function Test-Wsl2Ready {
  if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    return $false
  }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    # Default distro must start; exit 0 means a usable WSL2 (or WSL) environment.
    & wsl.exe -e true 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    $status = (& wsl.exe --status 2>&1 | Out-String) -replace "`0", ""
    if ($status -match "Default Version:\s*1\b") { return $false }
    return $true
  } catch {
    return $false
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Install-Wsl2Prompt {
  Write-Step "Microsoft install: wsl --install (admin/UAC; often needs a reboot)."
  Write-Note "Docs: https://learn.microsoft.com/windows/wsl/install"
  if (-not (Confirm-Yes "Install or repair WSL2 now?")) {
    Write-Note "Skipped WSL2. Docker Desktop's Linux-container backend may remain unavailable."
    $script:SKIPPED.Add("WSL2 (required by the recommended Docker Desktop backend)") | Out-Null
    return
  }
  try {
    Start-Process -FilePath "wsl.exe" -ArgumentList "--install" -Verb RunAs -Wait
  } catch {
    Write-WarnLine ("could not elevate wsl --install: " + $_.Exception.Message)
    Write-Note "Open an elevated PowerShell and run: wsl --install"
    $script:SKIPPED.Add("WSL2 install (elevation failed)") | Out-Null
    return
  }
  if (Test-Wsl2Ready) {
    Write-Ok "WSL2 is ready"
    return
  }
  Write-WarnLine "WSL2 is not ready yet - finish any reboot/distro setup, then re-run this wizard."
  $script:SKIPPED.Add("WSL2 (reboot or distro setup may still be required)") | Out-Null
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

function Get-NpmCommand {
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($npm) { return $npm }
  return (Get-Command npm -ErrorAction SilentlyContinue)
}

function Get-NpmGlobalBin {
  $npm = Get-NpmCommand
  $prefix = $null
  if ($npm) {
    try {
      $prefix = ((& $npm.Source prefix -g 2>$null) | Out-String).Trim()
    } catch {
      $prefix = $null
    }
  }
  if ([string]::IsNullOrWhiteSpace($prefix)) {
    $fallback = Join-Path $env:APPDATA "npm"
    if (Test-Path -LiteralPath $fallback) { return $fallback }
    return $null
  }
  $bin = Join-Path $prefix "bin"
  if (Test-Path -LiteralPath $bin) { return $bin }
  return $prefix
}

function Add-NpmGlobalBinToPath {
  $bin = Get-NpmGlobalBin
  if ([string]::IsNullOrWhiteSpace($bin)) { return $null }
  $parts = $env:PATH -split ';' | ForEach-Object { $_.TrimEnd('\') }
  if ($parts -notcontains $bin.TrimEnd('\')) {
    $env:PATH = "$bin;$env:PATH"
  }
  return $bin
}

function Get-NpmGlobalCliVersion {
  param([Parameter(Mandatory = $true)][string]$CommandName)
  $bin = Add-NpmGlobalBinToPath
  $candidates = @()
  if ($bin) {
    $candidates += @(
      (Join-Path $bin "$CommandName.cmd"),
      (Join-Path $bin "$CommandName.exe"),
      (Join-Path $bin $CommandName)
    )
  }
  foreach ($name in @("$CommandName.cmd", "$CommandName.exe", $CommandName)) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { $candidates += $cmd.Source }
  }
  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    try {
      $ver = (& $candidate --version 2>$null | Out-String).Trim()
      if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($ver)) {
        return $ver
      }
    } catch {
      continue
    }
  }
  return $null
}

function Get-GitnexusVersion { return Get-NpmGlobalCliVersion -CommandName "gitnexus" }
function Get-CodegraphVersion { return Get-NpmGlobalCliVersion -CommandName "codegraph" }

function Install-NpmGlobalPackage {
  param(
    [Parameter(Mandatory = $true)][string]$DisplayName,
    [Parameter(Mandatory = $true)][string]$PackageName,
    [Parameter(Mandatory = $true)][string]$CommandName
  )
  $existing = Get-NpmGlobalCliVersion -CommandName $CommandName
  if ($existing) {
    Write-Ok "$DisplayName already installed ($existing)"
    return
  }
  $npm = Get-NpmCommand
  if (-not $npm) {
    Write-Host "  npm is not on PATH - cannot install $DisplayName." -ForegroundColor Red
    Write-Note "Install Node.js (includes npm), then: npm install -g $PackageName"
    $script:SKIPPED.Add("$DisplayName (npm missing)") | Out-Null
    return
  }
  Write-Say "Running npm install -g $PackageName..."
  & $npm.Source install -g $PackageName
  if ($LASTEXITCODE -ne 0) {
    Write-Host "npm install -g $PackageName failed (exit $LASTEXITCODE)" -ForegroundColor Red
    $script:SKIPPED.Add("$DisplayName (npm install failed)") | Out-Null
    return
  }
  $bin = Add-NpmGlobalBinToPath
  $ver = Get-NpmGlobalCliVersion -CommandName $CommandName
  if ($ver) {
    Write-Ok "installed $DisplayName ($ver)"
    if ($bin) {
      Write-Note "npm global bin: $bin"
    }
  } else {
    Write-WarnLine "$DisplayName installed, but this session cannot find $CommandName --version."
    if ($bin) {
      Write-Note "Add $bin to your User PATH (Windows default: %AppData%\Roaming\npm), then open a new terminal."
    } else {
      Write-Note "Add %AppData%\Roaming\npm to your User PATH, then open a new terminal."
    }
    $script:SKIPPED.Add("$DisplayName PATH (new terminal may be required)") | Out-Null
  }
}

function Write-GitnexusLicenseWarning {
  Write-WarnLine "GitNexus is licensed under PolyForm Noncommercial License 1.0.0."
  Write-Note "Free for noncommercial / personal use only. Commercial use of the OSS package needs a separate license from Akon Labs."
  Write-Note "License: https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE"
  Write-Note "Commercial / enterprise: https://akonlabs.com or founders@akonlabs.com"
}

function Install-GitnexusCli {
  Install-NpmGlobalPackage -DisplayName "GitNexus" -PackageName "gitnexus" -CommandName "gitnexus"
}

function Install-CodegraphCli {
  Install-NpmGlobalPackage -DisplayName "CodeGraph" -PackageName "@colbymchenry/codegraph" -CommandName "codegraph"
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

# -- 2. Windows Docker backend (WSL2) --------------------------------------
Write-Stage "Windows Docker backend"
Write-Say "Production execution is Docker-only. Docker Desktop should use its WSL2 backend and Linux containers."
if (Test-Wsl2Ready) {
  Write-Ok "WSL2 is available"
} else {
  Write-WarnLine "WSL2 is missing, unfinished, or stuck on version 1; Docker Desktop may not be able to run Linux containers."
  Install-Wsl2Prompt
}

# -- 3. Required Docker execution runtime ----------------------------------
Write-Stage "Docker readiness"
Write-Say "Docker with Linux containers is required. Local worktrees and generated per-run images are retired."
Write-Note "This stage never silently installs Docker Desktop. If Desktop is already installed but stopped, it may offer to start it."
Write-Note "Bridge networking provides filesystem isolation, not an egress-proof boundary."
function Start-DockerDesktopIfPresent {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
  if (-not (Get-AgentHarnessDockerDesktopExe)) {
    Write-Note "Docker Desktop.exe not found. Install Docker Desktop yourself, then re-run this stage."
    return $false
  }
  if (-not (Confirm-Yes "Docker CLI is present but the daemon is not ready. Start Docker Desktop now?")) {
    return $false
  }
  return (Start-AgentHarnessDockerDesktop -TimeoutSec 120)
}
$dockerReady = Test-AgentHarnessDockerReady
if (-not $dockerReady) {
  $dockerReady = Start-DockerDesktopIfPresent
}
if ($dockerReady) {
  Write-Ok "docker info succeeded (Linux containers / daemon reachable)"
  $script:DockerDaemonReady = $true
  Write-Note "The maintained worker image will be rebuilt and probed after project registration."
} else {
  Write-WarnLine "Docker is required but docker info is not ready."
  Write-Note "Install/start Docker Desktop with the WSL2 backend and Linux containers, then re-run setup."
  exit 1
}

# -- 4. Build this checkout ------------------------------------------------
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
  Write-WarnLine "Build finished but $Cli is missing - registration will fail."
  exit 1
}
Write-Ok "built $Cli"

# -- 5. Cursor API key (Windows User env - never .env) ---------------------
Write-Stage "Cursor API key"
Write-Say "The dashboard does not need a key. Real Cursor runs use CURSOR_API_KEY (Windows User env or this session, never .env)."
Write-Note "The key is passed into the isolated run container. GITHUB_TOKEN and harness state remain host-only."
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
  if (Confirm-Yes "Save a Cursor API key now?") {
    Open-Url "https://cursor.com/dashboard/api"
    Write-Step "Create a user API key, then paste it here."
    $CursorApiKey = Read-AskSecret "Paste the Cursor API key:"
  }
  if ([string]::IsNullOrWhiteSpace($CursorApiKey)) {
    Write-Note "No key saved. The dashboard and deterministic checks are still available."
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

# -- 6. Target project + register ------------------------------------------
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
  Write-Note "Legacy repo-local state is unsupported. Archive or remove it after confirming the external registration."
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

# -- 7. Docker (optional; not a launch gate) --------------------------------
Write-Stage "Docker"
if (Test-AgentHarnessDockerReady) {
  Write-Ok "Docker is ready (Linux containers). Runs use one container each."
} else {
  Write-WarnLine "Docker is not ready. Fake-agent flows still work; isolated Cursor runs will not."
}

# -- 8. Repository intelligence --------------------------------------------
Write-Stage "Repository intelligence"
Write-Say "Harness structural lookup prefers GitNexus, then falls back to CodeGraph."
Write-Note "Both CLIs are optional. Skip either to leave that provider unset."
Write-Host ""
Write-GitnexusLicenseWarning
if (Confirm-Yes "Install GitNexus now (primary)? Confirm you understand the license terms above.") {
  Install-GitnexusCli
} else {
  Write-Note "Skipped GitNexus. Install later with: npm install -g gitnexus"
}
Write-Host ""
Write-Say "CodeGraph is the fallback structural provider."
Write-Note "Needs the codegraph CLI on PATH."
if (Confirm-Yes "Install CodeGraph now (fallback)?") {
  Install-CodegraphCli
} else {
  Write-Note "Skipped CodeGraph. Install later with: npm install -g @colbymchenry/codegraph"
}
Write-Note "Optional later: Ollama embeddings (packages/agent-harness/scripts/setup-local-embeddings.ps1)"

Write-Finish
Write-Say "Future launches: double-click scripts\Launch-AgentHarness.cmd and choose Open dashboard."

if ((Test-Path -LiteralPath $Cli) -and (Test-Path -LiteralPath $ProjectPath) -and
    (Confirm-Yes "Open the dashboard now?")) {
  & (Join-Path $PSScriptRoot "launch-agent-harness.ps1") -Project $ProjectPath -Action Dashboard -NoPull -NoBuild
  exit $LASTEXITCODE
}

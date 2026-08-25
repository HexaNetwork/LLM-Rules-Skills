#Requires -Version 5.1
<#
.SYNOPSIS
  Guided Windows launcher for Agent Harness.

.DESCRIPTION
  Menu for opening the dashboard, registering a project, checking Docker,
  or dumping the trusted host composition. One host process; one container
  per run. CURSOR_API_KEY may be passed into the run container.
#>
[CmdletBinding()]
param(
  [string]$Project = $env:AGENT_HARNESS_PROJECT,
  [switch]$NoPull,
  [switch]$NoBuild,
  [ValidateSet("Menu", "Dashboard", "Setup", "Check", "Config")]
  [string]$Action = "Menu"
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "lib\user-settings.ps1")
. (Join-Path $PSScriptRoot "lib\docker-ready.ps1")
. (Join-Path $PSScriptRoot "lib\live-ready.ps1")

$HarnessRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Cli = Join-Path $HarnessRoot "packages\agent-harness\dist\cli.js"
$NoPullWasSpecified = $PSBoundParameters.ContainsKey("NoPull")
$NoBuildWasSpecified = $PSBoundParameters.ContainsKey("NoBuild")
$script:BuildWorkerOnLaunch = $false

function Write-LauncherHeader {
  Clear-Host
  Write-Host ""
  Write-Host "  Agent Harness" -ForegroundColor Cyan
  Write-Host "  One host process · one container per run" -ForegroundColor DarkGray
  Write-Host ""
}

function Select-LauncherAction {
  Write-LauncherHeader
  Write-Host "  1  Open dashboard" -ForegroundColor White
  Write-Host "  2  Register a project"
  Write-Host "  3  Check Docker"
  Write-Host "  4  Inspect host composition"
  Write-Host "  Q  Close"
  Write-Host ""
  Write-Host "  Choose [1]: " -NoNewline
  $choice = (Read-Host).Trim()
  if ([string]::IsNullOrWhiteSpace($choice)) { return "Dashboard" }
  switch ($choice.ToUpperInvariant()) {
    "1" { return "Dashboard" }
    "2" { return "Setup" }
    "3" { return "Check" }
    "4" { return "Config" }
    "Q" { return "Quit" }
    default {
      Write-Host "  Unknown choice '$choice'." -ForegroundColor Yellow
      Start-Sleep -Seconds 1
      return (Select-LauncherAction)
    }
  }
}

function Resolve-LauncherProject {
  param([string]$Requested)
  if (-not [string]::IsNullOrWhiteSpace($Requested)) {
    return (Resolve-AgentHarnessProjectPath -Path $Requested)
  }
  $cwd = (Get-Location).Path
  foreach ($candidate in @(Get-AgentHarnessRememberedProjects)) {
    if ([string]::Equals($candidate, $cwd, [StringComparison]::OrdinalIgnoreCase)) {
      return $cwd
    }
  }
  return (Select-AgentHarnessProjectInteractive)
}

function Invoke-LauncherBuild {
  $launchDefaults = Get-AgentHarnessLaunchDefaults
  $doPull = if ($NoPullWasSpecified) { -not $NoPull } else { [bool]$launchDefaults.pullOnStart }
  $doBuild = if ($NoBuildWasSpecified) { -not $NoBuild } else { [bool]$launchDefaults.buildOnStart }
  $script:BuildWorkerOnLaunch = $doBuild

  Set-Location -LiteralPath $HarnessRoot
  if ($doPull) {
    $previousErrorPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $upstream = (& git rev-parse --abbrev-ref --symbolic-full-name "@{upstream}" 2>$null | Out-String).Trim()
    } finally {
      $ErrorActionPreference = $previousErrorPreference
    }
    if ([string]::IsNullOrWhiteSpace($upstream)) {
      Write-Host "  [1/3] Update skipped (current branch has no upstream)" -ForegroundColor DarkGray
    } else {
      Write-Host "  [1/3] Updating from $upstream..." -ForegroundColor Cyan
      & git pull --ff-only
      if ($LASTEXITCODE -ne 0) { throw "git pull failed (exit $LASTEXITCODE)" }
    }
  } else {
    Write-Host "  [1/3] Update skipped" -ForegroundColor DarkGray
  }
  if ($doBuild) {
    Write-Host "  [2/3] Installing packages and building..." -ForegroundColor Cyan
    & npm.cmd install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)" }
  } else {
    Write-Host "  [2/3] Build skipped" -ForegroundColor DarkGray
  }
  if (-not (Test-Path -LiteralPath $Cli)) {
    throw "The CLI is missing. Run setup, or launch again without -NoBuild."
  }
}

if ($Action -eq "Menu") {
  $Action = Select-LauncherAction
}
if ($Action -eq "Quit") { exit 0 }

Write-LauncherHeader
Invoke-LauncherBuild

if ($Action -eq "Config") {
  Write-Host ""
  Write-Host "  Host profile" -ForegroundColor Cyan
  & node $Cli dump-config
  exit $LASTEXITCODE
}

if ($Action -eq "Setup") {
  $Project = Resolve-LauncherProject -Requested $Project
  if ([string]::IsNullOrWhiteSpace($Project)) { throw "No project selected." }
  $Project = Resolve-AgentHarnessProjectPath -Path $Project
  & node $Cli project add --repository $Project
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  [void](Remember-AgentHarnessProject -Path $Project)
  Write-Host "  Registered $Project" -ForegroundColor Green
  exit 0
}

if ($Action -eq "Check") {
  if (Test-AgentHarnessDockerReady) {
    Write-Host "  Docker is ready (Linux containers)" -ForegroundColor Green
    exit 0
  }
  Write-Host "  Docker is not ready." -ForegroundColor Yellow
  exit 1
}

$Project = Resolve-LauncherProject -Requested $Project
if ([string]::IsNullOrWhiteSpace($Project)) {
  throw "No project selected. Choose setup to register one."
}
$Project = Resolve-AgentHarnessProjectPath -Path $Project
if (-not (Test-Path -LiteralPath $Project)) {
  throw "Project directory not found: $Project"
}
[void](Remember-AgentHarnessProject -Path $Project)
& node $Cli project add --repository $Project
if ($LASTEXITCODE -ne 0) { throw "project add failed (exit $LASTEXITCODE)" }

if ([string]::IsNullOrWhiteSpace($env:CURSOR_API_KEY)) {
  $env:CURSOR_API_KEY = [Environment]::GetEnvironmentVariable("CURSOR_API_KEY", "User")
}

$liveMode = Set-AgentHarnessLiveLaunchEnv
if ($liveMode) {
  if ($script:BuildWorkerOnLaunch) {
    Invoke-AgentHarnessWorkerPrepare -HarnessRoot $HarnessRoot
  }
  Invoke-AgentHarnessWorkerProbe
}

$uiDefaults = Get-AgentHarnessUiDefaults
$uiArgs = [System.Collections.Generic.List[string]]::new()
$uiArgs.Add("ui") | Out-Null
$uiArgs.Add("--repository") | Out-Null
$uiArgs.Add($Project) | Out-Null
$uiArgs.Add("--port") | Out-Null
$uiArgs.Add("$($uiDefaults.port)") | Out-Null
if (-not [bool]$uiDefaults.openBrowser) {
  $uiArgs.Add("--no-open") | Out-Null
}

Write-Host ""
Write-Host "  Opening dashboard for $Project" -ForegroundColor Green
Write-Host "  Keep this window open. The browser uses the one-time URL printed below." -ForegroundColor DarkGray
if ([string]::IsNullOrWhiteSpace($env:CURSOR_API_KEY)) {
  Write-Host "  CURSOR_API_KEY is not set. Fake-agent flows still work; live Cursor will not." -ForegroundColor Yellow
} else {
  Write-Host "  CURSOR_API_KEY will be passed into the run container environment." -ForegroundColor DarkGray
}
Set-Location -LiteralPath $Project
& node $Cli @uiArgs
exit $LASTEXITCODE

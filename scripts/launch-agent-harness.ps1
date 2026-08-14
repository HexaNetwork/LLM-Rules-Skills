#Requires -Version 5.1
<#
.SYNOPSIS
  Guided Windows launcher for Agent Harness.

.DESCRIPTION
  The no-argument experience is a small menu for opening the dashboard,
  setting up or repairing a project, checking Docker readiness, or inspecting
  the trusted vNext composition. Advanced callers can choose an action without
  prompts. Production execution is Docker-only.
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

$HarnessRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Cli = Join-Path $HarnessRoot "packages\agent-harness\dist\cli.js"
$NoPullWasSpecified = $PSBoundParameters.ContainsKey("NoPull")
$NoBuildWasSpecified = $PSBoundParameters.ContainsKey("NoBuild")

function Write-LauncherHeader {
  Clear-Host
  Write-Host ""
  Write-Host "  Agent Harness" -ForegroundColor Cyan
  Write-Host "  Docker-only guided launcher" -ForegroundColor DarkGray
  Write-Host ""
}

function Select-LauncherAction {
  Write-LauncherHeader
  Write-Host "  1  Open dashboard" -ForegroundColor White
  Write-Host "  2  Set up or repair a project"
  Write-Host "  3  Check Docker and worker readiness"
  Write-Host "  4  Inspect trusted vNext composition"
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

function Confirm-LauncherDocker {
  if (Test-AgentHarnessDockerReady) {
    Write-Host "  [3/3] Docker is ready (Linux containers)" -ForegroundColor Green
    return
  }
  Write-Host "  Docker is not ready. Trying an installed Docker Desktop..." -ForegroundColor Yellow
  if (-not (Start-AgentHarnessDockerDesktop -TimeoutSec 120)) {
    throw "Docker is required. Start Docker Desktop in Linux-container mode, wait for docker info to work, then retry."
  }
}

function Invoke-ReadinessCheck {
  param([Parameter(Mandatory = $true)][string]$Repository)
  Confirm-LauncherDocker
  Write-Host ""
  Write-Host "  Checking the maintained worker image and isolation probe..." -ForegroundColor Cyan
  $json = (& node $Cli execution status --repository $Repository --json | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "execution status failed (exit $LASTEXITCODE)" }
  $status = $json | ConvertFrom-Json
  if ([bool]$status.ready) {
    Write-Host "  Ready: Docker and the maintained worker passed all checks." -ForegroundColor Green
    return $true
  }
  Write-Host "  Not ready yet." -ForegroundColor Yellow
  foreach ($blocker in @($status.blockers)) {
    Write-Host ("    - " + $blocker.message)
    if ($blocker.remediation) { Write-Host ("      " + $blocker.remediation) -ForegroundColor DarkGray }
  }
  return $false
}

if ($Action -eq "Menu") {
  $Action = Select-LauncherAction
}
if ($Action -eq "Quit") { exit 0 }
if ($Action -eq "Setup") {
  & (Join-Path $PSScriptRoot "install-agent-harness.ps1")
  exit $LASTEXITCODE
}

Write-LauncherHeader
Invoke-LauncherBuild

if ($Action -eq "Config") {
  Write-Host ""
  Write-Host "  Host profile" -ForegroundColor Cyan
  & node $Cli vnext dump-config --profile host
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host ""
  Write-Host "  Worker profile" -ForegroundColor Cyan
  & node $Cli vnext dump-config --profile worker
  exit $LASTEXITCODE
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

if ($Action -eq "Check") {
  $ready = Invoke-ReadinessCheck -Repository $Project
  if ($ready) { exit 0 }
  exit 1
}

if (-not (Invoke-ReadinessCheck -Repository $Project)) {
  Write-Host ""
  Write-Host "  Prepare/repair the worker image now? [Y/n] " -ForegroundColor Yellow -NoNewline
  $answer = Read-Host
  if ($answer -match '^[Nn]') {
    throw "Worker readiness is required before the Docker-only harness can run."
  }
  & node $Cli execution prepare-worker --repository $Project --force-rebuild --write-settings
  if ($LASTEXITCODE -ne 0) { throw "Worker preparation failed (exit $LASTEXITCODE)." }
  if (-not (Invoke-ReadinessCheck -Repository $Project)) {
    throw "Worker preparation completed, but readiness is still blocked. Review the blockers above."
  }
}

if ([string]::IsNullOrWhiteSpace($env:CURSOR_API_KEY)) {
  $env:CURSOR_API_KEY = [Environment]::GetEnvironmentVariable("CURSOR_API_KEY", "User")
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
  Write-Host "  CURSOR_API_KEY is not set. The dashboard opens, but real agent execution is unavailable." -ForegroundColor Yellow
} else {
  Write-Host "  Note: real Cursor-in-Docker execution remains fail-closed until the credential isolation gate passes." -ForegroundColor Yellow
}
Set-Location -LiteralPath $Project
& node $Cli @uiArgs
exit $LASTEXITCODE

#Requires -Version 5.1
<#
.SYNOPSIS
  Pull the harness checkout, rebuild, and start the dashboard.

.DESCRIPTION
  When the target project has execution.runtime=docker and the daemon is down,
  starts Docker Desktop (if installed) and waits briefly before launching UI.

.EXAMPLE
  .\scripts\launch-agent-harness.ps1 -Project "C:\path\to\your-project"

.EXAMPLE
  $env:AGENT_HARNESS_PROJECT = "C:\path\to\your-project"
  .\scripts\launch-agent-harness.ps1
#>
[CmdletBinding()]
param(
  [string]$Project = $env:AGENT_HARNESS_PROJECT,
  [switch]$NoPull,
  [switch]$NoBuild
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "lib\user-settings.ps1")
. (Join-Path $PSScriptRoot "lib\docker-ready.ps1")

$HarnessRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Cli = Join-Path $HarnessRoot "packages\agent-harness\dist\cli.js"

# Project resolution: -Project / env > remembered cwd > interactive picker
if ([string]::IsNullOrWhiteSpace($Project)) {
  $cwd = (Get-Location).Path
  foreach ($candidate in @(Get-AgentHarnessRememberedProjects)) {
    if ([string]::Equals($candidate, $cwd, [StringComparison]::OrdinalIgnoreCase)) {
      $Project = $cwd
      break
    }
  }
}

if ([string]::IsNullOrWhiteSpace($Project)) {
  $Project = Select-AgentHarnessProjectInteractive
  if ([string]::IsNullOrWhiteSpace($Project)) {
    Write-Host "No target project. Pass -Project, set AGENT_HARNESS_PROJECT, or pick a registered project." -ForegroundColor Red
    exit 1
  }
}

$Project = Resolve-AgentHarnessProjectPath -Path $Project
if (-not (Test-Path -LiteralPath $Project)) {
  Write-Host "Project directory not found: $Project" -ForegroundColor Red
  Write-Host "Run the install wizard first: scripts\Install-AgentHarness.cmd" -ForegroundColor Red
  exit 1
}

# Persist choice and ensure defaults exist in user settings (no secrets).
[void](Remember-AgentHarnessProject -Path $Project)

# Launch / UI defaults from settings; explicit CLI flags win.
$launchDefaults = Get-AgentHarnessLaunchDefaults
$uiDefaults = Get-AgentHarnessUiDefaults

$doPull = if ($PSBoundParameters.ContainsKey("NoPull")) { -not $NoPull } else { [bool]$launchDefaults.pullOnStart }
$doBuild = if ($PSBoundParameters.ContainsKey("NoBuild")) { -not $NoBuild } else { [bool]$launchDefaults.buildOnStart }

if ([string]::IsNullOrWhiteSpace($env:CURSOR_API_KEY)) {
  $fromUser = [Environment]::GetEnvironmentVariable("CURSOR_API_KEY", "User")
  if (-not [string]::IsNullOrWhiteSpace($fromUser)) {
    $env:CURSOR_API_KEY = $fromUser
  }
}
if ([string]::IsNullOrWhiteSpace($env:CURSOR_API_KEY)) {
  Write-Warning "CURSOR_API_KEY is not set - agent runs will fail until it is."
}

Set-Location -LiteralPath $HarnessRoot

if ($doPull) {
  Write-Host "-> git pull --ff-only in $HarnessRoot"
  git pull --ff-only
  if ($LASTEXITCODE -ne 0) {
    Write-Host "git pull failed (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
  }
}

if ($doBuild) {
  Write-Host "-> npm install and npm run build"
  npm.cmd install
  if ($LASTEXITCODE -ne 0) {
    Write-Host "npm install failed (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
  }
  npm.cmd run build
  if ($LASTEXITCODE -ne 0) {
    Write-Host "npm run build failed (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
  }
}

if (-not (Test-Path -LiteralPath $Cli)) {
  Write-Host "Missing $Cli - run without -NoBuild, or build manually." -ForegroundColor Red
  exit 1
}

Ensure-AgentHarnessDockerForLaunch -Repository $Project

$uiArgs = [System.Collections.Generic.List[string]]::new()
$uiArgs.Add("ui") | Out-Null
$uiArgs.Add("--repository") | Out-Null
$uiArgs.Add($Project) | Out-Null
$uiArgs.Add("--port") | Out-Null
$uiArgs.Add("$($uiDefaults.port)") | Out-Null
if (-not [bool]$uiDefaults.openBrowser) {
  $uiArgs.Add("--no-open") | Out-Null
}

Write-Host "-> starting dashboard for $Project"
Write-Host "  Open the full http://127.0.0.1:<port>/?token=... URL printed below."
Set-Location -LiteralPath $Project
& node $Cli @uiArgs
exit $LASTEXITCODE

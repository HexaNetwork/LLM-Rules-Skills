#Requires -Version 5.1
<#
.SYNOPSIS
  Pull the harness checkout, rebuild, and start the dashboard.

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

$HarnessRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Cli = Join-Path $HarnessRoot "packages\agent-harness\dist\cli.js"

if ([string]::IsNullOrWhiteSpace($Project) -and (Test-Path -LiteralPath (Join-Path (Get-Location) "agent-harness.config.yaml"))) {
  $Project = (Get-Location).Path
}

if ([string]::IsNullOrWhiteSpace($Project)) {
  Write-Host "No target project specified (-Project / AGENT_HARNESS_PROJECT)."
  Write-Host -NoNewline "Absolute path to the deployed project: "
  $Project = Read-Host
  if ([string]::IsNullOrWhiteSpace($Project)) {
    Write-Host "No target project. Pass -Project, set AGENT_HARNESS_PROJECT, or cd into a deployed project." -ForegroundColor Red
    exit 1
  }
}

$Project = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Project)
$config = Join-Path $Project "agent-harness.config.yaml"
if (-not (Test-Path -LiteralPath $config)) {
  Write-Host "Missing agent-harness.config.yaml in: $Project" -ForegroundColor Red
  Write-Host "Run the install wizard first: scripts\Install-AgentHarness.cmd" -ForegroundColor Red
  exit 1
}

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

if (-not $NoPull) {
  Write-Host "-> git pull --ff-only in $HarnessRoot"
  git pull --ff-only
  if ($LASTEXITCODE -ne 0) {
    Write-Host "git pull failed (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
  }
}

if (-not $NoBuild) {
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

Write-Host "-> starting dashboard for $Project"
Write-Host "  Open the full http://127.0.0.1:<port>/?token=... URL printed below."
Set-Location -LiteralPath $Project
& node $Cli ui
exit $LASTEXITCODE

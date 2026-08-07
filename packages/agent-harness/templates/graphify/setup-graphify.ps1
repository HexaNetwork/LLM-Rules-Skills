[CmdletBinding()]
param(
  [string]$ProjectRoot = (Get-Location).Path,
  [switch]$InstallUv,
  [switch]$SkipGraphUpdate,
  [string]$Package = "graphifyy"
)

# This script is copied into <project>/agent-harness/scripts on deployment.
# It is intentionally ordinary PowerShell: review and customize it for your
# team's package mirror, pinned version, proxy, or bootstrap policy. Restore
# the harness version with: agent-harness graphify scripts --project . --reset

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path

function Find-CommandPath([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
}

function Find-Graphify {
  $onPath = Find-CommandPath "graphify"
  if ($onPath) { return $onPath }
  $local = Join-Path $env:USERPROFILE ".local\bin\graphify.exe"
  if (Test-Path -LiteralPath $local) { return $local }
  return $null
}

$graphify = Find-Graphify
if (-not $graphify) {
  $uv = Find-CommandPath "uv"
  $pipx = Find-CommandPath "pipx"
  if ($uv) {
    Write-Host "Installing $Package with uv..."
    & $uv tool install $Package
  } elseif ($pipx) {
    Write-Host "Installing $Package with pipx..."
    & $pipx install $Package
  } elseif ($InstallUv) {
    $winget = Find-CommandPath "winget"
    if (-not $winget) {
      throw "Neither uv nor pipx is installed, and winget is unavailable. Install uv or pipx, then run this script again."
    }
    Write-Host "Installing uv with winget..."
    & $winget install --id astral-sh.uv --exact --accept-package-agreements --accept-source-agreements
    $uv = Find-CommandPath "uv"
    if (-not $uv) {
      throw "uv was installed but is not on this shell's PATH yet. Open a new terminal and run this script again."
    }
    & $uv tool install $Package
  } else {
    throw "Graphify is not installed. Install uv or pipx, or rerun with -InstallUv to permit a winget uv install."
  }
  $graphify = Find-Graphify
}

if (-not $graphify) { throw "Graphify installation completed but the graphify command was not found." }
& $graphify --version

if (-not $SkipGraphUpdate) {
  Write-Host "Building/updating the structural graph for $ProjectRoot..."
  & $graphify update $ProjectRoot
}

Write-Host "Graphify is ready. The harness will refresh graphify-out/graph.json with each knowledge refresh."

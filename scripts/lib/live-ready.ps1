#Requires -Version 5.1
<#
.SYNOPSIS
  Live Cursor-in-Docker launch env and worker image prepare/probe.

.DESCRIPTION
  When Docker is ready and CURSOR_API_KEY is present, set process env
  AGENT_HARNESS_AGENTS=cursor, AGENT_HARNESS_SANDBOX=docker, and
  AGENT_HARNESS_WORKER_IMAGE=agent-harness-worker:local so the ui process
  can Start a live run. Otherwise leave those unset (fake-agent fallback).
  Worker prepare/probe builds that image. Host tracker tokens stay host-only.
#>

function Get-AgentHarnessLiveWorkerImage {
  return "agent-harness-worker:local"
}

function Resolve-AgentHarnessLiveLaunchEnv {
  param(
    [Parameter(Mandatory = $true)][bool]$DockerReady,
    [string]$CursorApiKey = $(if ($null -ne $env:CURSOR_API_KEY) { $env:CURSOR_API_KEY } else { "" })
  )
  if (-not $DockerReady) { return $null }
  if ([string]::IsNullOrWhiteSpace($CursorApiKey)) { return $null }
  return [pscustomobject]@{
    AGENT_HARNESS_AGENTS        = "cursor"
    AGENT_HARNESS_SANDBOX       = "docker"
    AGENT_HARNESS_WORKER_IMAGE  = (Get-AgentHarnessLiveWorkerImage)
  }
}

function Set-AgentHarnessLiveLaunchEnv {
  param([switch]$Quiet)
  $dockerReady = $false
  if (Get-Command Test-AgentHarnessDockerReady -ErrorAction SilentlyContinue) {
    $dockerReady = [bool](Test-AgentHarnessDockerReady)
  }
  $live = Resolve-AgentHarnessLiveLaunchEnv -DockerReady $dockerReady -CursorApiKey $env:CURSOR_API_KEY
  if ($null -eq $live) {
    if (-not $Quiet -and -not $dockerReady) {
      Write-Host "  Docker is not ready. Fake-agent flows still work; live Cursor will not." -ForegroundColor Yellow
    }
    return $false
  }
  $env:AGENT_HARNESS_AGENTS = [string]$live.AGENT_HARNESS_AGENTS
  $env:AGENT_HARNESS_SANDBOX = [string]$live.AGENT_HARNESS_SANDBOX
  $env:AGENT_HARNESS_WORKER_IMAGE = [string]$live.AGENT_HARNESS_WORKER_IMAGE
  if (-not $Quiet) {
    Write-Host "  Live mode: cursor in Docker ($($live.AGENT_HARNESS_WORKER_IMAGE))" -ForegroundColor DarkGray
  }
  return $true
}

function Get-AgentHarnessWorkerPackageRoot {
  param([string]$HarnessRoot)
  if ([string]::IsNullOrWhiteSpace($HarnessRoot)) {
    $HarnessRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
  }
  return (Join-Path $HarnessRoot "packages\agent-harness")
}

function Invoke-AgentHarnessWorkerPrepare {
  param(
    [string]$HarnessRoot,
    [string]$Tag
  )
  if ([string]::IsNullOrWhiteSpace($Tag)) {
    $Tag = Get-AgentHarnessLiveWorkerImage
  }
  $packageRoot = Get-AgentHarnessWorkerPackageRoot -HarnessRoot $HarnessRoot
  $dockerfile = Join-Path $packageRoot "docker\worker\Dockerfile"
  if (-not (Test-Path -LiteralPath $dockerfile)) {
    throw "Worker Dockerfile missing: $dockerfile"
  }
  $dist = Join-Path $packageRoot "dist"
  if (-not (Test-Path -LiteralPath $dist)) {
    throw "Worker dist is missing at $dist. Build the checkout first."
  }
  Write-Host "  Building worker image $Tag..."
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    Push-Location -LiteralPath $packageRoot
    try {
      & docker build -t $Tag -f "docker/worker/Dockerfile" .
      if ($LASTEXITCODE -ne 0) { throw "docker build failed (exit $LASTEXITCODE)" }
    } finally {
      Pop-Location
    }
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Invoke-AgentHarnessWorkerProbe {
  param([string]$Tag)
  if ([string]::IsNullOrWhiteSpace($Tag)) {
    $Tag = Get-AgentHarnessLiveWorkerImage
  }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & docker image inspect $Tag 1>$null
    if ($LASTEXITCODE -ne 0) { throw "worker image missing: $Tag" }
    & docker run --rm --entrypoint node $Tag -e "require('fs').accessSync('/opt/agent-harness/dist/worker/invoke.js')"
    if ($LASTEXITCODE -ne 0) { throw "worker image probe failed (exit $LASTEXITCODE)" }
  } finally {
    $ErrorActionPreference = $previous
  }
}

#Requires -Version 5.1
<#
.SYNOPSIS
  Shared Docker readiness helpers for install + launch scripts.

.DESCRIPTION
  Never installs Docker Desktop. May start an already-installed Desktop when the
  CLI is present but the daemon is down. Safe under $ErrorActionPreference Stop.
#>

function Test-AgentHarnessDockerReady {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
  # docker info writes NativeCommandError on stderr when the daemon is down;
  # with $ErrorActionPreference Stop that becomes a terminating error.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $info = & docker info 2>&1
    if ($LASTEXITCODE -ne 0) { return $false }
    $text = ($info | Out-String)
    if ($text -match "OSType:\s*windows" -and $text -notmatch "OSType:\s*linux") {
      Write-Host "  ! Docker is in Windows container mode. Switch Docker Desktop to Linux containers." -ForegroundColor Yellow
      return $false
    }
    return $true
  } catch {
    return $false
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Get-AgentHarnessDockerDesktopExe {
  $candidates = @(
    (Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Docker\Docker\Docker Desktop.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Docker\Docker\Docker Desktop.exe")
  )
  foreach ($candidate in $candidates) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }
  return $null
}

function Wait-AgentHarnessDockerReady {
  param(
    [int]$TimeoutSec = 120,
    [int]$IntervalSec = 3
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-AgentHarnessDockerReady) { return $true }
    Start-Sleep -Seconds $IntervalSec
  }
  return $false
}

function Start-AgentHarnessDockerDesktop {
  param(
    [int]$TimeoutSec = 120
  )
  if (-not ($IsWindows -or $env:OS -eq "Windows_NT")) { return $false }
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
  $exe = Get-AgentHarnessDockerDesktopExe
  if (-not $exe) { return $false }
  Write-Host "-> starting Docker Desktop: $exe"
  try {
    Start-Process -FilePath $exe | Out-Null
  } catch {
    Write-Host "  ! Could not start Docker Desktop: $($_.Exception.Message)" -ForegroundColor Yellow
    return $false
  }
  Write-Host "  Waiting for docker info (up to ~$TimeoutSec seconds)..." -ForegroundColor DarkGray
  if (Wait-AgentHarnessDockerReady -TimeoutSec $TimeoutSec) {
    Write-Host "  OK Docker daemon became ready" -ForegroundColor Green
    return $true
  }
  Write-Host "  ! Docker Desktop was started, but docker info is still failing." -ForegroundColor Yellow
  return $false
}

function Get-AgentHarnessProjectsRoot {
  $base = $env:LOCALAPPDATA
  if ([string]::IsNullOrWhiteSpace($base)) {
    $base = Join-Path $env:USERPROFILE "AppData\Local"
  }
  return (Join-Path $base "agent-harness\projects")
}

function Test-AgentHarnessPathsEqual {
  param([string]$Left, [string]$Right)
  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) {
    return $false
  }
  try {
    $a = [System.IO.Path]::GetFullPath($Left.TrimEnd('\', '/'))
    $b = [System.IO.Path]::GetFullPath($Right.TrimEnd('\', '/'))
    return [string]::Equals($a, $b, [StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

<#
.SYNOPSIS
  True when the registered project's harness-home config sets execution.runtime: docker.
#>
function Test-AgentHarnessProjectDockerRuntime {
  param([Parameter(Mandatory = $true)][string]$Repository)

  $projectsRoot = Get-AgentHarnessProjectsRoot
  if (-not (Test-Path -LiteralPath $projectsRoot)) { return $false }

  $resolved = $Repository
  try {
    if (Test-Path -LiteralPath $Repository) {
      $resolved = (Resolve-Path -LiteralPath $Repository).Path
    }
  } catch {
    $resolved = $Repository
  }

  foreach ($dir in Get-ChildItem -LiteralPath $projectsRoot -Directory -ErrorAction SilentlyContinue) {
    $regPath = Join-Path $dir.FullName "registration.json"
    if (-not (Test-Path -LiteralPath $regPath)) { continue }
    try {
      $reg = Get-Content -LiteralPath $regPath -Raw -ErrorAction Stop | ConvertFrom-Json
    } catch {
      continue
    }
    $roots = @($reg.controlRoot, $reg.canonicalControlRoot) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    $match = $false
    foreach ($root in $roots) {
      if (Test-AgentHarnessPathsEqual -Left $root -Right $resolved) {
        $match = $true
        break
      }
    }
    if (-not $match) { continue }

    $cfg = Join-Path $dir.FullName "config.yaml"
    if (-not (Test-Path -LiteralPath $cfg)) { return $false }
    try {
      $text = Get-Content -LiteralPath $cfg -Raw -ErrorAction Stop
    } catch {
      return $false
    }
    return [bool]($text -match '(?m)^\s*runtime:\s*["'']?docker["'']?\s*$')
  }
  return $false
}

<#
.SYNOPSIS
  When the project uses Docker runtime and the daemon is down, start Desktop and wait.
  No-op for local runtime. Does not fail launch if Docker stays down.
#>
function Ensure-AgentHarnessDockerForLaunch {
  param(
    [Parameter(Mandatory = $true)][string]$Repository,
    [int]$TimeoutSec = 120
  )
  if (-not (Test-AgentHarnessProjectDockerRuntime -Repository $Repository)) {
    return
  }
  if (Test-AgentHarnessDockerReady) {
    Write-Host "-> Docker runtime: daemon already ready"
    return
  }
  Write-Host "-> project execution.runtime=docker but daemon is not ready"
  if (Start-AgentHarnessDockerDesktop -TimeoutSec $TimeoutSec) {
    return
  }
  Write-Host "  ! Continuing launch anyway; Docker runs will fail until docker info works." -ForegroundColor Yellow
  Write-Host "  Start Docker Desktop manually, or set execution.runtime=local in project settings." -ForegroundColor DarkGray
}

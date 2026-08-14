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

<#
.SYNOPSIS
  Ensure the required Docker-only runtime is available for launch.
#>
function Ensure-AgentHarnessDockerForLaunch {
  param(
    [Parameter(Mandatory = $true)][string]$Repository,
    [int]$TimeoutSec = 120
  )
  $null = $Repository
  if (Test-AgentHarnessDockerReady) {
    Write-Host "-> Docker runtime: daemon ready (Linux containers)"
    return
  }
  Write-Host "-> Docker is required but the daemon is not ready"
  if (Start-AgentHarnessDockerDesktop -TimeoutSec $TimeoutSec) {
    return
  }
  throw "Docker is required. Start Docker Desktop in Linux-container mode and retry."
}

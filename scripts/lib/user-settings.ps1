#Requires -Version 5.1
<#
.SYNOPSIS
  User-local agent-harness settings (AppData), outside any project checkout.

.DESCRIPTION
  Path: %LOCALAPPDATA%\agent-harness\settings.json
  Stores remembered projects and machine launch/UI defaults.
  Never stores secrets (CURSOR_API_KEY stays in User env / shell profile).
#>

function Get-AgentHarnessSettingsPath {
  $base = $env:LOCALAPPDATA
  if ([string]::IsNullOrWhiteSpace($base)) {
    $base = Join-Path $env:USERPROFILE "AppData\Local"
  }
  return (Join-Path $base "agent-harness\settings.json")
}

function New-AgentHarnessDefaultSettings {
  return [pscustomobject]@{
    version     = 1
    lastProject = $null
    projects    = @()
    launch      = [pscustomobject]@{
      pullOnStart  = $true
      buildOnStart = $true
    }
    ui          = [pscustomobject]@{
      port        = 8787
      openBrowser = $true
    }
  }
}

function ConvertTo-AgentHarnessBool {
  param($Value, [bool]$Default)
  if ($null -eq $Value) { return $Default }
  if ($Value -is [bool]) { return $Value }
  if ($Value -is [int] -or $Value -is [long]) { return ($Value -ne 0) }
  $s = "$Value".Trim().ToLowerInvariant()
  if ($s -in @("true", "1", "yes", "on")) { return $true }
  if ($s -in @("false", "0", "no", "off")) { return $false }
  return $Default
}

function Merge-AgentHarnessSettings {
  param($Raw)
  $defaults = New-AgentHarnessDefaultSettings
  if ($null -eq $Raw) { return $defaults }

  $merged = [pscustomobject]@{
    version     = 1
    lastProject = $null
    projects    = @()
    launch      = [pscustomobject]@{
      pullOnStart  = $true
      buildOnStart = $true
    }
    ui          = [pscustomobject]@{
      port        = 8787
      openBrowser = $true
    }
  }

  if ($Raw.PSObject.Properties["version"] -and $null -ne $Raw.version) {
    try { $merged.version = [int]$Raw.version } catch { $merged.version = 1 }
  }
  if ($Raw.PSObject.Properties["lastProject"] -and -not [string]::IsNullOrWhiteSpace([string]$Raw.lastProject)) {
    $merged.lastProject = [string]$Raw.lastProject
  }

  $projects = @()
  if ($Raw.PSObject.Properties["projects"] -and $null -ne $Raw.projects) {
    foreach ($item in @($Raw.projects)) {
      if ($null -eq $item) { continue }
      $p = $null
      $used = $null
      if ($item -is [string]) {
        $p = $item
      } else {
        if ($item.PSObject.Properties["path"]) { $p = [string]$item.path }
        if ($item.PSObject.Properties["lastUsedAt"]) { $used = [string]$item.lastUsedAt }
      }
      if ([string]::IsNullOrWhiteSpace($p)) { continue }
      $projects += [pscustomobject]@{
        path       = $p
        lastUsedAt = $used
      }
    }
  }
  $merged.projects = $projects

  $launch = $Raw.launch
  if ($null -ne $launch) {
    if ($launch.PSObject.Properties["pullOnStart"]) {
      $merged.launch.pullOnStart = ConvertTo-AgentHarnessBool $launch.pullOnStart $true
    }
    if ($launch.PSObject.Properties["buildOnStart"]) {
      $merged.launch.buildOnStart = ConvertTo-AgentHarnessBool $launch.buildOnStart $true
    }
  }

  $ui = $Raw.ui
  if ($null -ne $ui) {
    if ($ui.PSObject.Properties["port"] -and $null -ne $ui.port) {
      try {
        $port = [int]$ui.port
        if ($port -gt 0 -and $port -le 65535) { $merged.ui.port = $port }
      } catch { }
    }
    if ($ui.PSObject.Properties["openBrowser"]) {
      $merged.ui.openBrowser = ConvertTo-AgentHarnessBool $ui.openBrowser $true
    }
  }

  return $merged
}

function Get-AgentHarnessSettings {
  $path = Get-AgentHarnessSettingsPath
  if (-not (Test-Path -LiteralPath $path)) {
    return (New-AgentHarnessDefaultSettings)
  }
  try {
    $text = Get-Content -LiteralPath $path -Raw -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($text)) {
      return (New-AgentHarnessDefaultSettings)
    }
    $raw = $text | ConvertFrom-Json
    return (Merge-AgentHarnessSettings $raw)
  } catch {
    Write-Warning "Could not read agent-harness settings at $path; using defaults. $($_.Exception.Message)"
    return (New-AgentHarnessDefaultSettings)
  }
}

function Save-AgentHarnessSettings {
  param(
    [Parameter(Mandatory = $true)]$Settings
  )
  $path = Get-AgentHarnessSettingsPath
  $dir = Split-Path -Parent $path
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $merged = Merge-AgentHarnessSettings $Settings
  $json = $merged | ConvertTo-Json -Depth 6
  Set-Content -LiteralPath $path -Value $json -Encoding UTF8
}

function Get-AgentHarnessLaunchDefaults {
  $s = Get-AgentHarnessSettings
  return [pscustomobject]@{
    pullOnStart  = [bool]$s.launch.pullOnStart
    buildOnStart = [bool]$s.launch.buildOnStart
  }
}

function Get-AgentHarnessUiDefaults {
  $s = Get-AgentHarnessSettings
  return [pscustomobject]@{
    port        = [int]$s.ui.port
    openBrowser = [bool]$s.ui.openBrowser
  }
}

function Resolve-AgentHarnessProjectPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  $expanded = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
  try {
    return [System.IO.Path]::GetFullPath($expanded)
  } catch {
    return $expanded
  }
}

function Remember-AgentHarnessProject {
  param([Parameter(Mandatory = $true)][string]$Path)
  $resolved = Resolve-AgentHarnessProjectPath -Path $Path
  $settings = Get-AgentHarnessSettings
  $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

  $list = [System.Collections.Generic.List[object]]::new()
  $found = $false
  foreach ($item in @($settings.projects)) {
    if ($null -eq $item -or [string]::IsNullOrWhiteSpace([string]$item.path)) { continue }
    $existing = Resolve-AgentHarnessProjectPath -Path ([string]$item.path)
    if ([string]::Equals($existing, $resolved, [StringComparison]::OrdinalIgnoreCase)) {
      $list.Add([pscustomobject]@{ path = $resolved; lastUsedAt = $now }) | Out-Null
      $found = $true
    } else {
      $list.Add([pscustomobject]@{
          path       = $existing
          lastUsedAt = $(if ($item.PSObject.Properties["lastUsedAt"]) { $item.lastUsedAt } else { $null })
        }) | Out-Null
    }
  }
  if (-not $found) {
    $list.Add([pscustomobject]@{ path = $resolved; lastUsedAt = $now }) | Out-Null
  }

  $settings.lastProject = $resolved
  $settings.projects = $list.ToArray()
  Save-AgentHarnessSettings -Settings $settings
  return $resolved
}

function Get-AgentHarnessRememberedProjects {
  <#
  .SYNOPSIS
    Remembered project paths that still exist on disk.
  #>
  $settings = Get-AgentHarnessSettings
  $valid = [System.Collections.Generic.List[string]]::new()
  foreach ($item in @($settings.projects)) {
    if ($null -eq $item -or [string]::IsNullOrWhiteSpace([string]$item.path)) { continue }
    try {
      $p = Resolve-AgentHarnessProjectPath -Path ([string]$item.path)
    } catch {
      continue
    }
    if (Test-Path -LiteralPath $p) {
      $dup = $false
      foreach ($existing in $valid) {
        if ([string]::Equals($existing, $p, [StringComparison]::OrdinalIgnoreCase)) {
          $dup = $true
          break
        }
      }
      if (-not $dup) { $valid.Add($p) | Out-Null }
    }
  }
  # Enumerate into the pipeline so callers can use @(Get-...) for 0/1/N items.
  # Do not use unary comma here: that nests String[] and prints as "System.String[]".
  return $valid.ToArray()
}

function Select-AgentHarnessProjectInteractive {
  <#
  .SYNOPSIS
    Interactive picker: remembered projects (default = lastProject) or type a new path.
  #>
  $settings = Get-AgentHarnessSettings
  $projects = @(Get-AgentHarnessRememberedProjects)
  $defaultPath = $null
  if (-not [string]::IsNullOrWhiteSpace([string]$settings.lastProject)) {
    try {
      $candidate = Resolve-AgentHarnessProjectPath -Path ([string]$settings.lastProject)
      if (Test-Path -LiteralPath $candidate) { $defaultPath = $candidate }
    } catch { }
  }

  if ($projects.Count -eq 0) {
    Write-Host "No target project specified (-Project / AGENT_HARNESS_PROJECT)."
    Write-Host -NoNewline "Absolute path to the registered project: "
    $typed = Read-Host
    if ([string]::IsNullOrWhiteSpace($typed)) { return $null }
    return (Resolve-AgentHarnessProjectPath -Path $typed)
  }

  Write-Host "Remembered projects:"
  $defaultIndex = -1
  for ($i = 0; $i -lt $projects.Count; $i++) {
    $mark = " "
    if ($null -ne $defaultPath -and [string]::Equals($projects[$i], $defaultPath, [StringComparison]::OrdinalIgnoreCase)) {
      $mark = "*"
      $defaultIndex = $i
    }
    Write-Host ("  {0}{1}) {2}" -f $mark, ($i + 1), $projects[$i])
  }
  Write-Host ("   {0}) Enter a different path" -f ($projects.Count + 1))

  $promptDefault = if ($defaultIndex -ge 0) { "$($defaultIndex + 1)" } else { "" }
  if ($promptDefault) {
    Write-Host -NoNewline "Choose project [$promptDefault]: "
  } else {
    Write-Host -NoNewline "Choose project: "
  }
  $reply = Read-Host
  if ([string]::IsNullOrWhiteSpace($reply)) {
    if ($defaultIndex -ge 0) { return $projects[$defaultIndex] }
    return $null
  }

  $asInt = 0
  if ([int]::TryParse($reply, [ref]$asInt)) {
    if ($asInt -ge 1 -and $asInt -le $projects.Count) {
      return $projects[$asInt - 1]
    }
    if ($asInt -eq ($projects.Count + 1)) {
      Write-Host -NoNewline "Absolute path to the target project: "
      $typed = Read-Host
      if ([string]::IsNullOrWhiteSpace($typed)) { return $null }
      return (Resolve-AgentHarnessProjectPath -Path $typed)
    }
  }

  # Treat non-numeric input as a path.
  return (Resolve-AgentHarnessProjectPath -Path $reply)
}

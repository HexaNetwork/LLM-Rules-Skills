<#
Runs the live host Cursor provider-proxy proof on explicit request.

CURSOR_API_KEY must already be set in this session or in the Windows User
environment. The key remains host-only and is never passed as a CLI argument
or injected into the Docker worker environment. Matching proof is cached and
reused across launches and key rotation; use -Force only when deliberately
refreshing evidence for the same release tuple.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Repository = "D:\Dev\LLM\Emperor-Test-Harness",
    [switch]$Force,
    [switch]$Json
)

$ErrorActionPreference = "Stop"
$HarnessRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Cli = Join-Path $HarnessRoot "packages\agent-harness\dist\cli.js"

if (-not (Test-Path -LiteralPath $Cli)) {
    throw "The Agent Harness CLI is missing. Run npm.cmd install and npm.cmd run build in $HarnessRoot."
}

if ([string]::IsNullOrWhiteSpace($env:CURSOR_API_KEY)) {
    $env:CURSOR_API_KEY = [Environment]::GetEnvironmentVariable("CURSOR_API_KEY", "User")
}

if ([string]::IsNullOrWhiteSpace($env:CURSOR_API_KEY)) {
    throw @"
CURSOR_API_KEY is not configured on the host. Set it for this session:
  `$env:CURSOR_API_KEY = "<key>"
or save it for your Windows user:
  [Environment]::SetEnvironmentVariable("CURSOR_API_KEY", "<key>", "User")
"@
}

Write-Host "Running the host provider-proxy proof against $Repository ..."
Write-Host "The Docker worker receives only HARNESS_RPC_URL and HARNESS_WORKER_TOKEN." -ForegroundColor DarkGray

$smokeArgs = @(
    $Cli,
    "execution",
    "cursor-provider-smoke",
    "--repository",
    $Repository
)
if ($Force) { $smokeArgs += "--force" }
if ($Json) { $smokeArgs += "--json" }

& node @smokeArgs
exit $LASTEXITCODE

<#
Runs the live cursor-provider-smoke proof with a temporary CURSOR_API_KEY.

The key is prompted with masked input, held only in this process's
environment for the duration of the run, and always removed afterward
(even on failure or Ctrl+C). It is never echoed, logged, or passed as an
argument. Remember to revoke the temporary key in the Cursor dashboard
when you are done.
#>
[CmdletBinding()]
param(
    [string]$Repository = "D:\Dev\LLM\Emperor-Test-Harness"
)

$ErrorActionPreference = "Stop"

$secureKey = Read-Host -Prompt "Paste temporary CURSOR_API_KEY" -AsSecureString
if ($secureKey.Length -eq 0) {
    Write-Error "No key provided; aborting."
    exit 1
}

$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
    $env:CURSOR_API_KEY = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

try {
    Write-Host "Running cursor-provider-smoke against $Repository ..."
    npx agent-harness execution cursor-provider-smoke --repository $Repository --force --json
    $exitCode = $LASTEXITCODE
} finally {
    Remove-Item Env:CURSOR_API_KEY -ErrorAction SilentlyContinue
    Set-Clipboard -Value " " -ErrorAction SilentlyContinue
    Write-Host "CURSOR_API_KEY cleared from environment and clipboard overwritten."
    Write-Host "Reminder: revoke the temporary key in the Cursor dashboard."
}

exit $exitCode

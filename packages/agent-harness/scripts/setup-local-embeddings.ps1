[CmdletBinding()]
param(
  [string]$Model = "qwen3-embedding",
  [switch]$InstallOllama
)

$ErrorActionPreference = "Stop"

function Get-OllamaCommand {
  $command = Get-Command ollama -ErrorAction SilentlyContinue
  if ($null -ne $command) { return $command.Source }
  $installed = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
  if (Test-Path -LiteralPath $installed) { return $installed }
  return $null
}

$ollama = Get-OllamaCommand
if ($null -eq $ollama -and $InstallOllama) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($null -eq $winget) {
    throw "Ollama is not installed and WinGet is unavailable. Install it from https://ollama.com/download/windows, then re-run this script."
  }
  & $winget.Source install --id Ollama.Ollama --exact --source winget --accept-package-agreements --accept-source-agreements
  $ollama = Get-OllamaCommand
}
if ($null -eq $ollama) {
  throw "Ollama is not installed. Install it from https://ollama.com/download/windows or run: .\setup-local-embeddings.ps1 -InstallOllama"
}

Write-Host "Pulling local embedding model '$Model'..."
& $ollama pull $Model
if ($LASTEXITCODE -ne 0) { throw "Ollama could not pull '$Model'." }

$request = @{ model = $Model; input = @("Agent Harness local embedding verification.") } | ConvertTo-Json -Compress
try {
  $response = Invoke-RestMethod -Method Post -ContentType "application/json" -Body $request -Uri "http://localhost:11434/api/embed"
} catch {
  throw "Ollama is installed but its local API is unavailable at http://localhost:11434. Start the Ollama app (or run 'ollama serve') and retry. $($_.Exception.Message)"
}
if ($null -eq $response.embeddings -or $response.embeddings.Count -ne 1) {
  throw "Ollama did not return an embedding vector for '$Model'."
}

Write-Host "Local embeddings are ready. Add this to agent-harness.config.yaml:"
@"
knowledge:
  embeddings:
    enabled: true
    provider: ollama
    endpoint: http://localhost:11434/api/embed
    model: $Model
"@

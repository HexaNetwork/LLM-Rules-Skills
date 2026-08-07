#!/usr/bin/env sh
set -eu

model="${1:-qwen3-embedding}"
if ! command -v ollama >/dev/null 2>&1; then
  echo "Ollama is not installed. Install it from https://ollama.com/download, then rerun this script." >&2
  exit 1
fi

ollama pull "$model"
curl --fail --silent --show-error \
  --header 'Content-Type: application/json' \
  --data "{\"model\":\"$model\",\"input\":[\"Agent Harness local embedding verification.\"]}" \
  http://localhost:11434/api/embed >/dev/null

cat <<EOF
Local embeddings are ready. Add this to agent-harness.config.yaml:
knowledge:
  embeddings:
    enabled: true
    provider: ollama
    endpoint: http://localhost:11434/api/embed
    model: $model
EOF

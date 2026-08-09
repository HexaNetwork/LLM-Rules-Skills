#!/usr/bin/env bash
#
# Launcher — git pull the harness checkout, rebuild, start the dashboard.
# Usage:
#   bash scripts/launch-agent-harness.sh [project-path]
#   AGENT_HARNESS_PROJECT=/path/to/project bash scripts/launch-agent-harness.sh
#
# Flags:
#   --no-pull    skip git pull
#   --no-build   skip npm install / build
#   -h, --help   show help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$HARNESS_ROOT/packages/agent-harness/dist/cli.js"

DO_PULL=1
DO_BUILD=1
PROJECT_PATH="${AGENT_HARNESS_PROJECT:-}"

usage() {
  cat <<'EOF'
Usage: bash scripts/launch-agent-harness.sh [project-path] [--no-pull] [--no-build]

  Pulls latest LLM-Rules-Skills, rebuilds the harness CLI, then starts `ui`
  against a project that already has agent-harness.config.yaml.

  Project path (first match wins):
    1. positional argument
    2. AGENT_HARNESS_PROJECT
    3. current working directory (if it contains agent-harness.config.yaml)

  CURSOR_API_KEY must be set (Windows User env is loaded automatically when empty).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --no-pull) DO_PULL=0; shift ;;
    --no-build) DO_BUILD=0; shift ;;
    -*)
      echo "Unknown flag: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      PROJECT_PATH="$1"
      shift
      ;;
  esac
done

if [[ -z "$PROJECT_PATH" && -f "$(pwd)/agent-harness.config.yaml" ]]; then
  PROJECT_PATH="$(pwd)"
fi
PROJECT_PATH="${PROJECT_PATH/#\~/$HOME}"

if [[ -z "$PROJECT_PATH" ]]; then
  echo "No target project. Pass a path, set AGENT_HARNESS_PROJECT, or cd into a deployed project." >&2
  exit 1
fi
if [[ ! -f "$PROJECT_PATH/agent-harness.config.yaml" ]]; then
  echo "Missing agent-harness.config.yaml in: $PROJECT_PATH" >&2
  echo "Run the install wizard first: bash scripts/install-agent-harness.sh" >&2
  exit 1
fi

# Load Windows User env when this shell has no key yet (Git Bash / MSYS).
if [[ -z "${CURSOR_API_KEY:-}" ]] && command -v powershell.exe >/dev/null 2>&1; then
  CURSOR_API_KEY="$(
    powershell.exe -NoProfile -Command \
      "\$v = [Environment]::GetEnvironmentVariable('CURSOR_API_KEY','User'); if (\$null -eq \$v) { '' } else { [Console]::Out.Write(\$v) }" \
      2>/dev/null | tr -d '\r'
  )"
  export CURSOR_API_KEY
fi
if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "Warning: CURSOR_API_KEY is not set — agent runs will fail until it is." >&2
fi

cd "$HARNESS_ROOT"

if [[ "$DO_PULL" -eq 1 ]]; then
  echo "→ git pull --ff-only in $HARNESS_ROOT"
  git pull --ff-only
fi

if [[ "$DO_BUILD" -eq 1 ]]; then
  echo "→ npm install && npm run build"
  npm install
  npm run build
fi

if [[ ! -f "$CLI" ]]; then
  echo "Missing $CLI — run without --no-build, or build manually." >&2
  exit 1
fi

echo "→ starting dashboard for $PROJECT_PATH"
echo "  Open the full http://127.0.0.1:…/?token=… URL printed below."
cd "$PROJECT_PATH"
exec node "$CLI" ui

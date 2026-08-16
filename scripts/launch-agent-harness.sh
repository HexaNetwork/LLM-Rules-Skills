#!/usr/bin/env bash
#
# Launcher — update, build, and start the dashboard.
# Usage:
#   bash scripts/launch-agent-harness.sh [project-path]
#   AGENT_HARNESS_PROJECT=/path/to/project bash scripts/launch-agent-harness.sh
#
# Flags:
#   --no-pull    skip git pull
#   --no-build   skip npm install / build
#   --config     dump the host composition
#   -h, --help   show help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$HARNESS_ROOT/packages/agent-harness/dist/cli.js"

# shellcheck source=lib/user-settings.sh
. "$SCRIPT_DIR/lib/user-settings.sh"

DO_PULL=1
DO_BUILD=1
ACTION="dashboard"
PROJECT_PATH="${AGENT_HARNESS_PROJECT:-}"

usage() {
  cat <<'EOF'
Usage: bash scripts/launch-agent-harness.sh [project-path] [--no-pull] [--no-build] [--config]

  Updates the checkout, rebuilds the harness CLI, registers the project,
  then starts the loopback dashboard.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-pull) DO_PULL=0; shift ;;
    --no-build) DO_BUILD=0; shift ;;
    --config) ACTION="config"; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      if [[ -z "$PROJECT_PATH" && "$1" != -* ]]; then
        PROJECT_PATH="$1"
        shift
      else
        echo "Unknown argument: $1" >&2
        usage
        exit 1
      fi
      ;;
  esac
done

cd "$HARNESS_ROOT"
if [[ "$DO_PULL" -eq 1 ]]; then
  if git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
    git pull --ff-only
  fi
fi
if [[ "$DO_BUILD" -eq 1 ]]; then
  npm install
  npm run build
fi
if [[ ! -f "$CLI" ]]; then
  echo "CLI missing at $CLI. Run without --no-build." >&2
  exit 1
fi

if [[ "$ACTION" == "config" ]]; then
  exec node "$CLI" dump-config
fi

if [[ -z "$PROJECT_PATH" ]]; then
  PROJECT_PATH="$(pwd)"
fi
PROJECT_PATH="$(cd "$PROJECT_PATH" && pwd)"
node "$CLI" project add --repository "$PROJECT_PATH"

if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "CURSOR_API_KEY is unset. Fake-agent flows still work; live Cursor will not."
fi

exec node "$CLI" ui --repository "$PROJECT_PATH"

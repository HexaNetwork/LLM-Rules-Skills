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
#
# Machine defaults (pull/build/port/browser) come from user settings.json
# under AppData / XDG config when flags are omitted. See INSTALL.md §5.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$HARNESS_ROOT/packages/agent-harness/dist/cli.js"

# shellcheck source=lib/user-settings.sh
. "$SCRIPT_DIR/lib/user-settings.sh"

DO_PULL=1
DO_BUILD=1
PULL_FLAG_SET=0
BUILD_FLAG_SET=0
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
    4. interactive picker from remembered projects (user settings.json)
    5. prompt for a path

  Launch/UI defaults (when flags omitted) come from user settings.json:
    Windows: %LOCALAPPDATA%\agent-harness\settings.json
    Unix:    ${XDG_CONFIG_HOME:-$HOME/.config}/agent-harness/settings.json

  CURSOR_API_KEY must be set (Windows User env is loaded automatically when empty).
  Never stored in settings.json.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --no-pull) DO_PULL=0; PULL_FLAG_SET=1; shift ;;
    --no-build) DO_BUILD=0; BUILD_FLAG_SET=1; shift ;;
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
  if ! PROJECT_PATH="$(ah_select_project_interactive)"; then
    echo "No target project. Pass a path, set AGENT_HARNESS_PROJECT, or cd into a deployed project." >&2
    exit 1
  fi
fi

# Normalize to absolute when possible.
if [[ -d "$PROJECT_PATH" ]]; then
  PROJECT_PATH="$(cd "$PROJECT_PATH" && pwd)"
fi

if [[ ! -f "$PROJECT_PATH/agent-harness.config.yaml" ]]; then
  echo "Missing agent-harness.config.yaml in: $PROJECT_PATH" >&2
  echo "Run the install wizard first: bash scripts/install-agent-harness.sh" >&2
  exit 1
fi

ah_remember_project "$PROJECT_PATH" >/dev/null

# Apply launch defaults when flags were omitted.
launch_defaults="$(ah_get_launch_defaults)"
IFS=$'\t' read -r pull_default build_default <<<"$launch_defaults"
if [[ "$PULL_FLAG_SET" -eq 0 ]]; then
  DO_PULL="$pull_default"
fi
if [[ "$BUILD_FLAG_SET" -eq 0 ]]; then
  DO_BUILD="$build_default"
fi

ui_defaults="$(ah_get_ui_defaults)"
IFS=$'\t' read -r UI_PORT UI_OPEN <<<"$ui_defaults"

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

UI_ARGS=(ui --port "$UI_PORT")
if [[ "$UI_OPEN" -eq 0 ]]; then
  UI_ARGS+=(--no-open)
fi

echo "→ starting dashboard for $PROJECT_PATH"
echo "  Open the full http://127.0.0.1:…/?token=… URL printed below."
cd "$PROJECT_PATH"
exec node "$CLI" "${UI_ARGS[@]}"

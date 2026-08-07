#!/usr/bin/env bash
set -euo pipefail

# This script is copied into <project>/agent-harness/scripts on deployment.
# It is intentionally ordinary shell: review and customize it for your team's
# package mirror, pinned version, proxy, or bootstrap policy. Restore the
# harness version with: agent-harness graphify scripts --project . --reset

project_root="$(pwd)"
package="graphifyy"
install_uv=0
skip_graph_update=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-root) project_root="$2"; shift 2 ;;
    --package) package="$2"; shift 2 ;;
    --install-uv) install_uv=1; shift ;;
    --skip-graph-update) skip_graph_update=1; shift ;;
    --help)
      echo "Usage: $0 [--project-root PATH] [--package graphifyy] [--install-uv] [--skip-graph-update]"
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

project_root="$(cd "$project_root" && pwd)"
graphify_bin="$(command -v graphify || true)"

if [[ -z "$graphify_bin" && -x "$HOME/.local/bin/graphify" ]]; then
  graphify_bin="$HOME/.local/bin/graphify"
fi

if [[ -z "$graphify_bin" ]]; then
  if command -v uv >/dev/null 2>&1; then
    echo "Installing $package with uv..."
    uv tool install "$package"
  elif command -v pipx >/dev/null 2>&1; then
    echo "Installing $package with pipx..."
    pipx install "$package"
  elif [[ "$install_uv" -eq 1 ]]; then
    echo "Installing uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
    uv tool install "$package"
  else
    echo "Graphify is not installed. Install uv or pipx, or rerun with --install-uv to permit the official uv bootstrap." >&2
    exit 1
  fi
  graphify_bin="$(command -v graphify || true)"
  if [[ -z "$graphify_bin" && -x "$HOME/.local/bin/graphify" ]]; then
    graphify_bin="$HOME/.local/bin/graphify"
  fi
fi

if [[ -z "$graphify_bin" ]]; then
  echo "Graphify installation completed but the graphify command was not found." >&2
  exit 1
fi

"$graphify_bin" --version

if [[ "$skip_graph_update" -eq 0 ]]; then
  echo "Building/updating the structural graph for $project_root..."
  "$graphify_bin" update "$project_root"
fi

echo "Graphify is ready. The harness will refresh graphify-out/graph.json with each knowledge refresh."

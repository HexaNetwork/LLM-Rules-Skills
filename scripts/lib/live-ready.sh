# Live Cursor-in-Docker launch env and worker image prepare/probe.
# When Docker is ready and CURSOR_API_KEY is present, export
# AGENT_HARNESS_AGENTS=cursor, AGENT_HARNESS_SANDBOX=docker, and
# AGENT_HARNESS_WORKER_IMAGE=agent-harness-worker:local.
# Otherwise leave those unset (fake-agent fallback).
# Host tracker tokens stay host-only; they are never passed to docker.

AH_LIVE_WORKER_IMAGE="${AH_LIVE_WORKER_IMAGE:-agent-harness-worker:local}"

ah_live_worker_image() {
  printf '%s' "${AH_LIVE_WORKER_IMAGE:-agent-harness-worker:local}"
}

ah_docker_ready() {
  command -v docker >/dev/null 2>&1 || return 1
  local info
  if ! info="$(docker info 2>&1)"; then
    return 1
  fi
  if printf '%s' "$info" | grep -qi 'OSType:[[:space:]]*windows' \
    && ! printf '%s' "$info" | grep -qi 'OSType:[[:space:]]*linux'; then
    return 1
  fi
  return 0
}

ah_resolve_live_launch_env() {
  local docker_ready="${1:-0}"
  local key="${2:-${CURSOR_API_KEY:-}}"
  local trimmed="${key#"${key%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  if [[ "$docker_ready" != "1" || -z "$trimmed" ]]; then
    return 1
  fi
  printf 'AGENT_HARNESS_AGENTS=cursor\n'
  printf 'AGENT_HARNESS_SANDBOX=docker\n'
  printf 'AGENT_HARNESS_WORKER_IMAGE=%s\n' "$(ah_live_worker_image)"
}

ah_set_live_launch_env() {
  local ready=0
  if type _docker_ready >/dev/null 2>&1; then
    if _docker_ready; then ready=1; fi
  elif ah_docker_ready; then
    ready=1
  fi
  local key="${CURSOR_API_KEY:-}"
  local trimmed="${key#"${key%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  if [[ "$ready" -eq 1 && -n "$trimmed" ]]; then
    export AGENT_HARNESS_AGENTS=cursor
    export AGENT_HARNESS_SANDBOX=docker
    AGENT_HARNESS_WORKER_IMAGE="$(ah_live_worker_image)"
    export AGENT_HARNESS_WORKER_IMAGE
    echo "Live mode: cursor in Docker ($AGENT_HARNESS_WORKER_IMAGE)"
    return 0
  fi
  if [[ "$ready" -ne 1 ]]; then
    echo "Docker is not ready. Fake-agent flows still work; live Cursor will not."
  fi
  return 0
}

ah_worker_package_root() {
  local harness_root="${1:-}"
  if [[ -z "$harness_root" ]]; then
    harness_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  fi
  printf '%s/packages/agent-harness' "$harness_root"
}

ah_worker_prepare() {
  local harness_root="${1:-}"
  local tag="${2:-$(ah_live_worker_image)}"
  local package_root
  package_root="$(ah_worker_package_root "$harness_root")"
  if [[ ! -f "$package_root/docker/worker/Dockerfile" ]]; then
    echo "Worker Dockerfile missing: $package_root/docker/worker/Dockerfile" >&2
    return 1
  fi
  if [[ ! -d "$package_root/dist" ]]; then
    echo "Worker dist is missing at $package_root/dist. Build the checkout first." >&2
    return 1
  fi
  echo "Building worker image $tag..."
  (
    cd "$package_root"
    docker build -t "$tag" -f docker/worker/Dockerfile .
  )
}

ah_worker_probe() {
  local tag="${1:-$(ah_live_worker_image)}"
  docker image inspect "$tag" >/dev/null
  docker run --rm --entrypoint node "$tag" -e "require('fs').accessSync('/opt/agent-harness/dist/worker/invoke.js')"
}

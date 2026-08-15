#!/usr/bin/env bash
#
# User-local agent-harness settings (AppData / XDG), outside any project checkout.
#
# Windows:  %LOCALAPPDATA%/agent-harness/settings.json
# Unix:     ${XDG_CONFIG_HOME:-$HOME/.config}/agent-harness/settings.json
#
# Stores remembered projects and machine launch/UI defaults.
# Never stores secrets (CURSOR_API_KEY stays in User env / shell profile).
#
# Requires: node (same as the harness CLI).
# Source this file:  . scripts/lib/user-settings.sh

# shellcheck disable=SC2034

ah_settings_path() {
  if [[ -n "${LOCALAPPDATA:-}" ]]; then
    # Windows (native PowerShell env, Git Bash, etc.)
    printf '%s' "${LOCALAPPDATA}/agent-harness/settings.json"
    return
  fi
  local xdg="${XDG_CONFIG_HOME:-}"
  if [[ -z "$xdg" ]]; then
    xdg="${HOME}/.config"
  fi
  printf '%s' "${xdg}/agent-harness/settings.json"
}

# Internal: run JSON ops via node. Ops: load | remember | get-launch | get-ui | list-valid | get-last
_ah_settings_node() {
  local op="$1"
  shift
  AH_SETTINGS_PATH="$(ah_settings_path)" \
  AH_SETTINGS_OP="$op" \
  AH_SETTINGS_ARG1="${1:-}" \
  AH_SETTINGS_ARG2="${2:-}" \
  node <<'NODE'
const fs = require("fs");
const path = require("path");
const os = require("os");

const settingsPath = process.env.AH_SETTINGS_PATH;
const op = process.env.AH_SETTINGS_OP;
const args = [process.env.AH_SETTINGS_ARG1, process.env.AH_SETTINGS_ARG2].filter(
  (a) => a != null && a !== "",
);

const defaults = () => ({
  version: 1,
  lastProject: null,
  projects: [],
  launch: { pullOnStart: true, buildOnStart: true },
  ui: { port: 8787, openBrowser: true },
});

function toBool(v, d) {
  if (v === undefined || v === null) return d;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  return d;
}

function merge(raw) {
  const out = defaults();
  if (!raw || typeof raw !== "object") return out;
  if (raw.version != null) {
    const n = Number(raw.version);
    if (Number.isFinite(n)) out.version = n;
  }
  if (raw.lastProject != null && String(raw.lastProject).trim()) {
    out.lastProject = String(raw.lastProject);
  }
  const projects = [];
  if (Array.isArray(raw.projects)) {
    for (const item of raw.projects) {
      if (item == null) continue;
      let p = null;
      let used = null;
      if (typeof item === "string") p = item;
      else {
        if (item.path != null) p = String(item.path);
        if (item.lastUsedAt != null) used = String(item.lastUsedAt);
      }
      if (!p || !p.trim()) continue;
      projects.push({ path: p, lastUsedAt: used });
    }
  }
  out.projects = projects;
  if (raw.launch && typeof raw.launch === "object") {
    out.launch.pullOnStart = toBool(raw.launch.pullOnStart, true);
    out.launch.buildOnStart = toBool(raw.launch.buildOnStart, true);
  }
  if (raw.ui && typeof raw.ui === "object") {
    const port = Number(raw.ui.port);
    if (Number.isInteger(port) && port > 0 && port <= 65535) out.ui.port = port;
    out.ui.openBrowser = toBool(raw.ui.openBrowser, true);
  }
  return out;
}

function load() {
  try {
    if (!fs.existsSync(settingsPath)) return defaults();
    const text = fs.readFileSync(settingsPath, "utf8");
    if (!text.trim()) return defaults();
    return merge(JSON.parse(text));
  } catch {
    return defaults();
  }
}

function save(settings) {
  const dir = path.dirname(settingsPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(merge(settings), null, 2) + os.EOL, "utf8");
}

function resolvePath(p) {
  if (!p) return p;
  let expanded = p;
  if (expanded.startsWith("~/") || expanded === "~") {
    expanded = path.join(os.homedir(), expanded.slice(2) || ".");
  }
  return path.resolve(expanded);
}

function pathKey(p) {
  const n = path.normalize(p);
  return process.platform === "win32" ? n.toLowerCase() : n;
}

function projectExists(projectPath) {
  try {
    return fs.existsSync(projectPath) && fs.statSync(projectPath).isDirectory();
  } catch {
    return false;
  }
}

function remember(projectPath) {
  const resolved = resolvePath(projectPath);
  const settings = load();
  const now = new Date().toISOString();
  const list = [];
  let found = false;
  for (const item of settings.projects) {
    const existing = resolvePath(item.path);
    if (pathKey(existing) === pathKey(resolved)) {
      list.push({ path: resolved, lastUsedAt: now });
      found = true;
    } else {
      list.push({ path: existing, lastUsedAt: item.lastUsedAt || null });
    }
  }
  if (!found) list.push({ path: resolved, lastUsedAt: now });
  settings.lastProject = resolved;
  settings.projects = list;
  save(settings);
  process.stdout.write(resolved);
}

function listValid() {
  const settings = load();
  const seen = new Set();
  const out = [];
  for (const item of settings.projects) {
    if (!item || !item.path) continue;
    const p = resolvePath(item.path);
    const key = pathKey(p);
    if (seen.has(key)) continue;
    if (!projectExists(p)) continue;
    seen.add(key);
    out.push(p);
  }
  if (out.length) process.stdout.write(out.join("\n") + "\n");
}

function getLastProject() {
  const settings = load();
  if (!settings.lastProject) {
    process.stdout.write("");
    return;
  }
  const p = resolvePath(settings.lastProject);
  process.stdout.write(projectExists(p) ? p : "");
}

switch (op) {
  case "load":
    process.stdout.write(JSON.stringify(load()));
    break;
  case "remember":
    if (!args[0]) {
      console.error("remember requires a project path");
      process.exit(1);
    }
    remember(args[0]);
    break;
  case "get-launch": {
    const s = load();
    process.stdout.write(
      JSON.stringify({
        pullOnStart: !!s.launch.pullOnStart,
        buildOnStart: !!s.launch.buildOnStart,
      }),
    );
    break;
  }
  case "get-ui": {
    const s = load();
    process.stdout.write(
      JSON.stringify({
        port: s.ui.port,
        openBrowser: !!s.ui.openBrowser,
      }),
    );
    break;
  }
  case "list-valid":
    listValid();
    break;
  case "get-last":
    getLastProject();
    break;
  default:
    console.error("Unknown settings op: " + op);
    process.exit(1);
}
NODE
}

ah_get_launch_defaults() {
  # Prints: pullOnStart<TAB>buildOnStart as 0/1
  local json
  json="$(_ah_settings_node get-launch)"
  AH_JSON="$json" node -e '
const s = JSON.parse(process.env.AH_JSON);
process.stdout.write((s.pullOnStart ? "1" : "0") + "\t" + (s.buildOnStart ? "1" : "0"));
'
}

ah_get_ui_defaults() {
  # Prints: port<TAB>openBrowser(0/1)
  local json
  json="$(_ah_settings_node get-ui)"
  AH_JSON="$json" node -e '
const s = JSON.parse(process.env.AH_JSON);
process.stdout.write(String(s.port) + "\t" + (s.openBrowser ? "1" : "0"));
'
}

ah_remember_project() {
  local project_path="$1"
  if [[ -z "$project_path" ]]; then
    echo "ah_remember_project: path required" >&2
    return 1
  fi
  _ah_settings_node remember "$project_path"
}

ah_list_remembered_projects() {
  _ah_settings_node list-valid
}

ah_get_last_project() {
  _ah_settings_node get-last
}

ah_select_project_interactive() {
  # Echoes chosen absolute path to stdout; returns 1 if none.
  local projects=()
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    projects+=("$line")
  done < <(ah_list_remembered_projects)

  local default_path
  default_path="$(ah_get_last_project || true)"

  if [[ ${#projects[@]} -eq 0 ]]; then
    echo "No target project. Pass a path, set AGENT_HARNESS_PROJECT, or cd into a registered project." >&2
    printf 'Absolute path to the target project: ' >&2
    local typed=""
    read -r typed || true
    typed="${typed/#\~/$HOME}"
    if [[ -z "$typed" ]]; then
      return 1
    fi
    printf '%s\n' "$(cd "$typed" 2>/dev/null && pwd || printf '%s' "$typed")"
    return 0
  fi

  echo "Remembered projects:" >&2
  local i default_index=-1
  for i in "${!projects[@]}"; do
    local mark=" "
    if [[ -n "$default_path" && "${projects[$i]}" == "$default_path" ]]; then
      mark="*"
      default_index=$i
    fi
    printf '  %s%d) %s\n' "$mark" "$((i + 1))" "${projects[$i]}" >&2
  done
  printf '   %d) Enter a different path\n' "$(( ${#projects[@]} + 1 ))" >&2

  local prompt="Choose project: "
  if [[ "$default_index" -ge 0 ]]; then
    prompt="Choose project [$((default_index + 1))]: "
  fi
  printf '%s' "$prompt" >&2
  local reply=""
  read -r reply || true

  if [[ -z "$reply" ]]; then
    if [[ "$default_index" -ge 0 ]]; then
      printf '%s\n' "${projects[$default_index]}"
      return 0
    fi
    return 1
  fi

  if [[ "$reply" =~ ^[0-9]+$ ]]; then
    local idx=$((reply - 1))
    if [[ "$idx" -ge 0 && "$idx" -lt ${#projects[@]} ]]; then
      printf '%s\n' "${projects[$idx]}"
      return 0
    fi
    if [[ "$reply" -eq $(( ${#projects[@]} + 1 )) ]]; then
      printf 'Absolute path to the target project: ' >&2
      local typed=""
      read -r typed || true
      typed="${typed/#\~/$HOME}"
      if [[ -z "$typed" ]]; then
        return 1
      fi
      printf '%s\n' "$(cd "$typed" 2>/dev/null && pwd || printf '%s' "$typed")"
      return 0
    fi
  fi

  # Treat non-numeric input as a path.
  reply="${reply/#\~/$HOME}"
  printf '%s\n' "$(cd "$reply" 2>/dev/null && pwd || printf '%s' "$reply")"
}

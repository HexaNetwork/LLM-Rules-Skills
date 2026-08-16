import os from "node:os";
import path from "node:path";

export function defaultHarnessHome(): string {
  const override = process.env.AGENT_HARNESS_HOME?.trim();
  if (override) return path.resolve(override);
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA?.trim();
    return path.join(local && local.length > 0 ? local : path.join(os.homedir(), "AppData", "Local"), "agent-harness");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "agent-harness");
  }
  const xdg = process.env.XDG_STATE_HOME?.trim();
  return path.join(xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".local", "state"), "agent-harness");
}

export function projectKeyFor(controlRoot: string): string {
  const base = path.basename(path.resolve(controlRoot)).replace(/[^a-zA-Z0-9._-]+/g, "-") || "project";
  const digest = simpleHash(path.resolve(controlRoot));
  return `${base}-${digest}`;
}

function simpleHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

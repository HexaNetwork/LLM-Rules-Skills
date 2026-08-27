import type { ContainerSpec } from "./mount-policy.js";

/** Explicit resolvers avoid flaky Docker Desktop embedded DNS (ENOTFOUND api.cursor.com). */
export const WORKER_DNS_SERVERS = ["8.8.8.8", "1.1.1.1"] as const;

export function buildDockerRunArgs(spec: ContainerSpec): string[] {
  const args: string[] = [
    "run",
    "-d",
    "--name",
    spec.name,
    "--network",
    "bridge",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
  ];
  for (const mount of spec.mounts) {
    const suffix = mount.readOnly ? ":ro" : "";
    args.push("-v", `${mount.host}:${mount.container}${suffix}`);
  }
  for (const dns of WORKER_DNS_SERVERS) {
    args.push("--dns", dns);
  }
  const envEntries: Array<[string, string]> = [
    ["CURSOR_API_KEY", spec.env.CURSOR_API_KEY ?? ""],
    ["HOME", spec.env.HOME ?? "/tmp"],
  ];
  for (const [name, value] of Object.entries(spec.env)) {
    if (value === undefined) continue;
    if (name === "CURSOR_API_KEY" || name === "HOME") continue;
    envEntries.push([name, value]);
  }
  for (const [name, value] of envEntries) {
    args.push("-e", `${name}=${value}`);
  }
  args.push("-w", "/workspace", spec.image, "sleep", "infinity");
  return args;
}

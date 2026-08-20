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
    "-v",
    `${spec.worktreeHost}:/workspace`,
  ];
  for (const dns of WORKER_DNS_SERVERS) {
    args.push("--dns", dns);
  }
  args.push(
    "-e",
    `CURSOR_API_KEY=${spec.env.CURSOR_API_KEY ?? ""}`,
    "-e",
    "HOME=/tmp",
    "-w",
    "/workspace",
    spec.image,
    "sleep",
    "infinity",
  );
  return args;
}

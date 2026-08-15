import type { Context } from "@deepseek-ai/cordis";
import type { HardenedContainerSpec } from "../../infrastructure/container/container-spec.js";
import type { SecurityPolicyService } from "../services/contracts.js";

export function assertProductionContainerSpec(spec: HardenedContainerSpec): void {
  const workspaceMounts = spec.mounts.filter((mount) => mount.target === "/workspace");
  const workspaceMount = workspaceMounts[0];
  if (
    workspaceMounts.length !== 1 ||
    !workspaceMount ||
    workspaceMount.readOnly
  ) {
    throw new Error("Security policy requires exactly one read-write workspace mount");
  }
  if (!spec.readOnlyRootfs) throw new Error("Security policy requires a read-only root filesystem");
  if (spec.user === "0" || spec.user.startsWith("0:") || spec.user === "root") {
    throw new Error("Security policy forbids a root worker");
  }
  if (!spec.dropAllCapabilities) throw new Error("Security policy requires all capabilities dropped");
  if (!spec.noNewPrivileges) throw new Error("Security policy requires no-new-privileges");
  if (!spec.network || spec.network === ("host" as never)) {
    throw new Error("Security policy requires an explicit non-host network mode");
  }
  if (spec.limits.cpus <= 0 || spec.limits.memoryMb <= 0 || spec.limits.pidsLimit <= 0) {
    throw new Error("Security policy requires positive CPU, memory, and PID limits");
  }
  for (const mount of spec.mounts) {
    const coordinates = `${mount.source}:${mount.target}`.replaceAll("\\", "/").toLowerCase();
    if (
      coordinates.includes("docker.sock") ||
      mount.target === "/run-state" ||
      mount.target.startsWith("/run-state/") ||
      mount.target === "/run/secrets" ||
      mount.target.startsWith("/run/secrets/") ||
      mount.target === "/root" ||
      mount.target === "/home"
    ) {
      throw new Error(`Security policy rejected forbidden mount ${mount.target}`);
    }
    if (mount.kind === "bind") {
      const workspace = mount.target === "/workspace" && mount.readOnly === false;
      const publicTrust =
        mount.readOnly && mount.target.startsWith("/run/agent-harness-public/");
      if (!workspace && !publicTrust) {
        throw new Error(
          "Only the host worktree and read-only public trust files may be bind-mounted",
        );
      }
    }
  }
}

export function securityPolicyPlugin(ctx: Context): void {
  const service: SecurityPolicyService = {
    validate: assertProductionContainerSpec,
  };
  ctx.provide("securityPolicy", service);
}

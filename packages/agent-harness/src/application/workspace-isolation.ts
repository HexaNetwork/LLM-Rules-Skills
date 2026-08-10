import path from "node:path";
import { HarnessFailure } from "../errors.js";
import type { AgentBackend } from "../infrastructure/agents/types.js";
import { isPathUnderControlRoot, pathsEqual } from "./harness-home.js";
import type { HarnessPaths } from "./paths.js";

/** Declared provider ability to restrict the writable workspace root. */
export type WorkspaceCapabilities = {
  /** Provider can bind agent tools to a single writable cwd/workspace. */
  canRestrictWritableWorkspace: boolean;
  /** Human-readable provider id for diagnostics. */
  providerId: string;
};

export type IsolationCheckInput = {
  paths: HarnessPaths;
  /** Harness home root that must never be a writable agent mount. */
  homeRoot: string;
  strictIsolation: boolean;
  capabilities: WorkspaceCapabilities;
  /** Optional cwd that will be passed to the agent. */
  agentCwd?: string;
};

export type IsolationCheckResult = {
  ok: boolean;
  writableWorkspaceRoot: string;
  issues: string[];
};

/**
 * Enforce the agent isolation boundary: writable root is the run worktree,
 * harness home is never exposed as a writable mount.
 */
export function checkWorkspaceIsolation(input: IsolationCheckInput): IsolationCheckResult {
  const issues: string[] = [];
  const writable = path.resolve(input.agentCwd ?? input.paths.workspaceRoot);
  const homeRoot = path.resolve(input.homeRoot);

  if (isPathUnderControlRoot(writable, homeRoot) || pathsEqual(writable, homeRoot)) {
    issues.push(
      `Agent writable workspace must not be the harness home (${homeRoot}); got ${writable}`,
    );
  }

  if (
    input.paths.workspaceRoot !== input.paths.controlRoot &&
    !pathsEqual(writable, input.paths.workspaceRoot) &&
    !isPathUnderControlRoot(writable, input.paths.workspaceRoot)
  ) {
    issues.push(
      `Agent writable workspace ${writable} is outside the run worktree ${input.paths.workspaceRoot}`,
    );
  }

  if (input.strictIsolation && !input.capabilities.canRestrictWritableWorkspace) {
    issues.push(
      `Strict isolation is enabled but provider ${input.capabilities.providerId} cannot restrict the writable workspace.`,
    );
  }

  return {
    ok: issues.length === 0,
    writableWorkspaceRoot: writable,
    issues,
  };
}

export function assertWorkspaceIsolation(input: IsolationCheckInput): IsolationCheckResult {
  const result = checkWorkspaceIsolation(input);
  if (!result.ok) {
    throw new HarnessFailure(result.issues.join(" "), "config", false);
  }
  return result;
}

/** Prefer backend-advertised capabilities; Cursor local agents restrict via `local.cwd`. */
export function capabilitiesForBackend(
  backend: AgentBackend,
  providerId = "cursor",
): WorkspaceCapabilities {
  const advertised = backend.workspaceCapabilities?.();
  if (advertised) return advertised;
  if (providerId === "cursor") {
    return { canRestrictWritableWorkspace: true, providerId };
  }
  return { canRestrictWritableWorkspace: false, providerId };
}

/**
 * Test helper: list roots that must not appear as agent-writable mounts.
 */
export function forbiddenAgentWritableRoots(paths: HarnessPaths, homeRoot: string): string[] {
  return [path.resolve(homeRoot), path.resolve(paths.stateRoot)].filter(
    (root) => !pathsEqual(root, paths.workspaceRoot),
  );
}

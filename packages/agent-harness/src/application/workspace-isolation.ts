import path from "node:path";
import { HarnessFailure } from "../errors.js";
import type { AgentBackend } from "../infrastructure/agents/types.js";
import { pathsEqual } from "./harness-home.js";
import {
  WORKER_WORKSPACE_PATH,
  type HarnessPaths,
} from "./paths.js";

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
  /**
   * When true, treat `/workspace` as an opaque container path
   * (Docker worker). Isolation probes gate advertising restrict capability.
   */
  containerExecution?: boolean;
  /** Set after fail-closed sandbox probe succeeds; defaults false. */
  sandboxIsolationProbePassed?: boolean;
};

export type IsolationCheckResult = {
  ok: boolean;
  writableWorkspaceRoot: string;
  issues: string[];
};

/**
 * Normalize path comparisons for host paths and Docker worker constants.
 * On Windows, `path.resolve("/workspace")` becomes a drive-rooted path — keep
 * container constants opaque so isolation checks stay meaningful.
 */
export function normalizeExecutionPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized === WORKER_WORKSPACE_PATH ||
    normalized === "/run/secrets" ||
    normalized.startsWith(`${WORKER_WORKSPACE_PATH}/`) ||
    normalized.startsWith("/run/secrets/")
  ) {
    return normalized;
  }
  return path.resolve(value).replaceAll("\\", "/");
}

function executionPathsEqual(left: string, right: string): boolean {
  const a = normalizeExecutionPath(left);
  const b = normalizeExecutionPath(right);
  if (process.platform === "win32" && !a.startsWith("/") && !b.startsWith("/")) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function isUnderExecutionRoot(child: string, parent: string): boolean {
  const childKey = normalizeExecutionPath(child);
  const parentKey = normalizeExecutionPath(parent).replace(/\/+$/, "");
  if (childKey === parentKey) return true;
  const prefix = parentKey.endsWith("/") ? parentKey : `${parentKey}/`;
  if (process.platform === "win32" && !childKey.startsWith("/") && !parentKey.startsWith("/")) {
    return childKey.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return childKey.startsWith(prefix);
}

/**
 * Enforce the agent isolation boundary: writable root is `/workspace` in Docker;
 * harness home and secret mounts are never writable.
 */
export function checkWorkspaceIsolation(input: IsolationCheckInput): IsolationCheckResult {
  const issues: string[] = [];
  const container =
    input.containerExecution === true ||
    input.paths.workspaceRoot === WORKER_WORKSPACE_PATH ||
    (input.agentCwd != null && normalizeExecutionPath(input.agentCwd) === WORKER_WORKSPACE_PATH);
  const writable = normalizeExecutionPath(input.agentCwd ?? input.paths.workspaceRoot);
  const homeRoot = path.resolve(input.homeRoot);

  if (!container && (isUnderExecutionRoot(writable, homeRoot) || pathsEqual(writable, homeRoot))) {
    issues.push(
      `Agent writable workspace must not be the harness home (${homeRoot}); got ${writable}`,
    );
  }

  if (container) {
    if (writable !== WORKER_WORKSPACE_PATH && !writable.startsWith(`${WORKER_WORKSPACE_PATH}/`)) {
      issues.push(
        `Docker agent writable workspace must be ${WORKER_WORKSPACE_PATH}; got ${writable}`,
      );
    }
  } else if (
    input.paths.workspaceRoot !== input.paths.controlRoot &&
    !executionPathsEqual(writable, input.paths.workspaceRoot) &&
    !isUnderExecutionRoot(writable, input.paths.workspaceRoot)
  ) {
    issues.push(
      `Agent writable workspace ${writable} is outside the configured workspace ${input.paths.workspaceRoot}`,
    );
  }

  const canRestrict = input.capabilities.canRestrictWritableWorkspace;

  if (input.strictIsolation && !canRestrict) {
    issues.push(
      `Strict isolation is enabled but provider ${input.capabilities.providerId} cannot restrict the writable workspace.`,
    );
  }

  if (
    input.strictIsolation &&
    container &&
    input.sandboxIsolationProbePassed !== true
  ) {
    issues.push(
      "Strict isolation is enabled for Docker but the sandbox isolation probe has not passed yet.",
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

/** Gate backend-advertised capabilities on the Docker sandbox proof. */
export function capabilitiesForBackend(
  backend: AgentBackend,
  providerId = "cursor",
  options?: {
    sandboxIsolationProbePassed?: boolean;
  },
): WorkspaceCapabilities {
  const advertised = backend.workspaceCapabilities?.();
  const probePassed = options?.sandboxIsolationProbePassed === true;
  if (advertised) {
    return {
      ...advertised,
      canRestrictWritableWorkspace: probePassed && advertised.canRestrictWritableWorkspace,
    };
  }
  return {
    canRestrictWritableWorkspace: probePassed,
    providerId,
  };
}

/**
 * Test helper: list roots that must not appear as agent-writable mounts.
 */
export function forbiddenAgentWritableRoots(paths: HarnessPaths, homeRoot: string): string[] {
  const roots = [path.resolve(homeRoot), path.resolve(paths.stateRoot)];
  if (paths.workspaceRoot === WORKER_WORKSPACE_PATH) {
    roots.push("/run/secrets");
  }
  return roots.filter((root) => !executionPathsEqual(root, paths.workspaceRoot));
}

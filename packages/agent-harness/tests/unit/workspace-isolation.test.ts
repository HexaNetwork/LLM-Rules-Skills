import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertWorkspaceIsolation,
  checkWorkspaceIsolation,
  forbiddenAgentWritableRoots} from "../../src/application/workspace-isolation.js";
import { WORKER_WORKSPACE_PATH } from "../../src/application/paths.js";
import type { AgentBackend } from "../../src/infrastructure/agents/types.js";

describe("workspace isolation", () => {
  const controlRoot = path.resolve("/tmp/repo");
  const stateRoot = path.resolve("/tmp/harness-home/projects/p1");
  const workspaceRoot = WORKER_WORKSPACE_PATH;
  const homeRoot = path.resolve("/tmp/harness-home");

  const paths = {
    controlRoot,
    stateRoot,
    workspaceRoot};

  it("accepts the Docker workspace as the writable root", () => {
    const result = checkWorkspaceIsolation({
      paths,
      homeRoot,
      strictIsolation: true,
      capabilities: { canRestrictWritableWorkspace: true, providerId: "cursor" },
      agentCwd: workspaceRoot,
      containerExecution: true,
      sandboxIsolationProbePassed: true});
    expect(result.ok).toBe(true);
    expect(forbiddenAgentWritableRoots(paths, homeRoot)).toEqual(
      expect.arrayContaining([homeRoot, stateRoot]),
    );
  });

  it("rejects a non-Docker writable agent mount", () => {
    const result = checkWorkspaceIsolation({
      paths,
      homeRoot,
      strictIsolation: false,
      capabilities: { canRestrictWritableWorkspace: true, providerId: "cursor" },
      agentCwd: homeRoot});
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/Docker agent writable workspace/);
  });

  it("accepts a host worktree under harness home as the writable root", () => {
    const worktreeRoot = path.join(stateRoot, "worktrees", "run-wt");
    const result = checkWorkspaceIsolation({
      paths: {
        controlRoot,
        stateRoot,
        workspaceRoot: worktreeRoot,
      },
      homeRoot,
      strictIsolation: false,
      capabilities: { canRestrictWritableWorkspace: true, providerId: "cursor" },
      agentCwd: worktreeRoot,
      containerExecution: false,
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects harness home itself as a host writable root", () => {
    const result = checkWorkspaceIsolation({
      paths: {
        controlRoot,
        stateRoot,
        workspaceRoot: homeRoot,
      },
      homeRoot,
      strictIsolation: false,
      capabilities: { canRestrictWritableWorkspace: true, providerId: "cursor" },
      agentCwd: homeRoot,
      containerExecution: false,
    });
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/must not be the harness home/);
  });

  it("rejects a harness-home path outside the configured host workspace", () => {
    const worktreeRoot = path.join(stateRoot, "worktrees", "run-wt");
    const otherUnderHome = path.join(homeRoot, "guidance");
    const result = checkWorkspaceIsolation({
      paths: {
        controlRoot,
        stateRoot,
        workspaceRoot: worktreeRoot,
      },
      homeRoot,
      strictIsolation: false,
      capabilities: { canRestrictWritableWorkspace: true, providerId: "cursor" },
      agentCwd: otherUnderHome,
      containerExecution: false,
    });
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/harness home|outside the configured workspace/);
  });

  it("refuses strict isolation when the provider cannot restrict the workspace", () => {
    expect(() =>
      assertWorkspaceIsolation({
        paths,
        homeRoot,
        strictIsolation: true,
        capabilities: { canRestrictWritableWorkspace: false, providerId: "open" },
        agentCwd: workspaceRoot,
        containerExecution: true,
        sandboxIsolationProbePassed: true}),
    ).toThrow(/cannot restrict the writable workspace/);
  });

  it("uses backend-advertised capabilities", () => {
    const backend: AgentBackend = {
      async run() {
        throw new Error("unused");
      },
      workspaceCapabilities: () => ({
        canRestrictWritableWorkspace: false,
        providerId: "incapable"})};
    expect(() =>
      assertWorkspaceIsolation({
        paths,
        homeRoot,
        strictIsolation: true,
        capabilities: backend.workspaceCapabilities!(),
        agentCwd: workspaceRoot,
        containerExecution: true,
        sandboxIsolationProbePassed: true}),
    ).toThrow(/incapable/);
  });
});

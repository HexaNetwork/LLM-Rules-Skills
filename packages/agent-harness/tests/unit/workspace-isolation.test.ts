import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertWorkspaceIsolation,
  checkWorkspaceIsolation,
  forbiddenAgentWritableRoots} from "../../src/application/workspace-isolation.js";
import type { AgentBackend } from "../../src/infrastructure/agents/types.js";

describe("workspace isolation", () => {
  const controlRoot = path.resolve("/tmp/repo");
  const stateRoot = path.resolve("/tmp/harness-home/projects/p1");
  const worktreeRoot = path.resolve("/tmp/repo-worktrees");
  const workspaceRoot = path.join(worktreeRoot, "run-1");
  const homeRoot = path.resolve("/tmp/harness-home");

  const paths = {
    controlRoot,
    stateRoot,
    workspaceRoot,
    worktreeRoot};

  it("accepts the run worktree as the writable root", () => {
    const result = checkWorkspaceIsolation({
      paths,
      homeRoot,
      strictIsolation: true,
      capabilities: { canRestrictWritableWorkspace: true, providerId: "cursor" },
      agentCwd: workspaceRoot});
    expect(result.ok).toBe(true);
    expect(forbiddenAgentWritableRoots(paths, homeRoot)).toEqual(
      expect.arrayContaining([homeRoot, stateRoot]),
    );
  });

  it("rejects harness home as a writable agent mount", () => {
    const result = checkWorkspaceIsolation({
      paths,
      homeRoot,
      strictIsolation: false,
      capabilities: { canRestrictWritableWorkspace: true, providerId: "cursor" },
      agentCwd: homeRoot});
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/harness home/);
  });

  it("refuses strict isolation when the provider cannot restrict the workspace", () => {
    expect(() =>
      assertWorkspaceIsolation({
        paths,
        homeRoot,
        strictIsolation: true,
        capabilities: { canRestrictWritableWorkspace: false, providerId: "open" },
        agentCwd: workspaceRoot}),
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
        agentCwd: workspaceRoot}),
    ).toThrow(/incapable/);
  });
});

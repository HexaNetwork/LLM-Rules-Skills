import { describe, expect, it } from "vitest";
import {
  WORKSPACE_EVIDENCE_CHANGED_PATHS_LIMIT,
  boundWorkspaceChangedPaths,
  buildWorkspaceEvidence,
  describeWorkspaceDivergence,
  diffWorkspaceEvidence,
  formatWorkspaceDivergenceMessage} from "../../src/domain/workspace.js";

function evidence(overrides: Partial<{
  headSha: string;
  indexTreeSha: string;
  statusDigest: string;
  changedPaths: string[];
}> = {}) {
  return buildWorkspaceEvidence({
    headSha: "a".repeat(40),
    indexTreeSha: "b".repeat(40),
    statusDigest: "c".repeat(64),
    changedPaths: ["src/a.ts"],
    ...overrides});
}

describe("boundWorkspaceChangedPaths", () => {
  it("sorts and bounds diagnostic paths with an omitted count", () => {
    const paths = Array.from({ length: WORKSPACE_EVIDENCE_CHANGED_PATHS_LIMIT + 3 }, (_, i) =>
      `f${String(i).padStart(3, "0")}.ts`,
    );
    const bounded = boundWorkspaceChangedPaths(paths);
    expect(bounded.changedPaths).toHaveLength(WORKSPACE_EVIDENCE_CHANGED_PATHS_LIMIT);
    expect(bounded.omittedCount).toBe(3);
    expect(bounded.changedPaths[0]).toBe("f000.ts");
  });
});

describe("diffWorkspaceEvidence", () => {
  it("reports no components when fingerprints match", () => {
    const baseline = evidence();
    expect(diffWorkspaceEvidence(baseline, evidence())).toEqual({
      head: false,
      index: false,
      workingFiles: false,
      changedPaths: [],
      omittedCount: 0});
  });

  it("detects HEAD, index, and working-file components separately", () => {
    const baseline = evidence();
    expect(
      diffWorkspaceEvidence(
        baseline,
        evidence({ headSha: "d".repeat(40) }),
      ),
    ).toMatchObject({ head: true, index: false, workingFiles: false });

    expect(
      diffWorkspaceEvidence(
        baseline,
        evidence({ indexTreeSha: "e".repeat(40) }),
      ),
    ).toMatchObject({ head: false, index: true, workingFiles: false });

    expect(
      diffWorkspaceEvidence(
        baseline,
        evidence({ statusDigest: "f".repeat(64), changedPaths: ["external.txt"] }),
      ),
    ).toMatchObject({
      head: false,
      index: false,
      workingFiles: true,
      changedPaths: ["external.txt"]});
  });
});

describe("formatWorkspaceDivergenceMessage", () => {
  it("names which components diverged and lists bounded paths", () => {
    const previous = evidence();
    const observed = evidence({
      headSha: "d".repeat(40),
      statusDigest: "f".repeat(64),
      changedPaths: ["external-edit.txt", "src/a.ts"]});
    const diff = diffWorkspaceEvidence(previous, observed);
    const message = formatWorkspaceDivergenceMessage(diff, observed);
    expect(message).toMatch(/Workspace diverged in this run's worktree/i);
    expect(message).toMatch(/HEAD/);
    expect(message).toMatch(/working files/i);
    expect(message).not.toMatch(/\bindex\b/i);
    expect(message).toContain("external-edit.txt");
    expect(describeWorkspaceDivergence(diff)).toContain("HEAD");
  });
});

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RunWorkspaceSchema,
  WorkspaceEvidenceSchema,
  WORKSPACE_EVIDENCE_FINGERPRINT_VERSION,
  assertWorktreePathContained,
  buildWorkspaceEvidence,
  canonicalizeWorkspacePath,
  migrateRunWorkspace,
  sanitizeWorktreeRunId,
  workspaceEvidenceFingerprint,
} from "../../src/domain/workspace.js";

describe("RunWorkspaceSchema", () => {
  it("accepts a version-1 git-worktree record", () => {
    const parsed = RunWorkspaceSchema.parse({
      version: 1,
      kind: "git-worktree",
      controlRoot: "D:/repo",
      worktreePath: "D:/repo/.agent-harness/worktrees/run-1",
      gitCommonDir: "D:/repo/.git",
      baseBranch: "main",
      baseSha: "abc123",
      createdAt: "2026-08-10T12:00:00.000Z",
    });
    expect(parsed.version).toBe(1);
    expect(parsed.kind).toBe("git-worktree");
    expect(parsed.branchName).toBeUndefined();
    expect(parsed.removedAt).toBeUndefined();
  });

  it("accepts git-disabled kind", () => {
    expect(
      RunWorkspaceSchema.parse({
        version: 1,
        kind: "git-disabled",
        controlRoot: "/repo",
        createdAt: "2026-08-10T12:00:00.000Z",
      }).kind,
    ).toBe("git-disabled");
  });

  it("accepts a docker-clone record with stable identity only", () => {
    const parsed = RunWorkspaceSchema.parse({
      version: 1,
      kind: "docker-clone",
      controlRoot: "/repo",
      containerName: "harness-run-abc",
      workspaceVolumeName: "harness-ws-abc",
      workspacePath: "/workspace",
      imageDigest: "sha256:deadbeef",
      baseSha: "abc123",
      seedBundleHash: "bundlehash",
      generation: 0,
      createdAt: "2026-08-10T12:00:00.000Z",
    });
    expect(parsed.kind).toBe("docker-clone");
    if (parsed.kind === "docker-clone") {
      expect(parsed.workspacePath).toBe("/workspace");
      expect(parsed.containerName).toBe("harness-run-abc");
      expect(parsed.generation).toBe(0);
    }
  });

  it("rejects unknown versions, kinds, and legacy-shared", () => {
    expect(() =>
      RunWorkspaceSchema.parse({
        version: 2,
        kind: "git-worktree",
        controlRoot: "/repo",
        createdAt: "2026-08-10T12:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      RunWorkspaceSchema.parse({
        version: 1,
        kind: "other",
        controlRoot: "/repo",
        createdAt: "2026-08-10T12:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      RunWorkspaceSchema.parse({
        version: 1,
        kind: "legacy-shared",
        controlRoot: "/repo",
        createdAt: "2026-08-10T12:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("migrateRunWorkspace", () => {
  it("rejects missing workspace metadata", () => {
    expect(() =>
      migrateRunWorkspace(undefined, {
        controlRoot: "/project",
        createdAt: "2026-08-10T12:00:00.000Z",
      }),
    ).toThrow(/workspace metadata is missing/i);
  });

  it("rejects legacy-shared workspace records", () => {
    expect(() =>
      migrateRunWorkspace(
        {
          version: 1,
          kind: "legacy-shared",
          controlRoot: "/project",
          createdAt: "2026-08-10T12:00:00.000Z",
        },
        { controlRoot: "/project" },
      ),
    ).toThrow(/legacy-shared/i);
  });

  it("canonicalizes stored paths on migration", () => {
    const migrated = migrateRunWorkspace(
      {
        version: 1,
        kind: "git-worktree",
        controlRoot: path.join("/project", "."),
        worktreePath: path.join("/project", ".agent-harness", "worktrees", "run-1"),
        gitCommonDir: path.join("/project", ".git"),
        createdAt: "2026-08-10T12:00:00.000Z",
      },
      { controlRoot: "/unused" },
    );
    expect(migrated.controlRoot).toBe(canonicalizeWorkspacePath("/project"));
    expect(migrated.worktreePath).toBe(
      canonicalizeWorkspacePath(path.join("/project", ".agent-harness", "worktrees", "run-1")),
    );
  });
});

describe("worktree path policy", () => {
  it("sanitizes run ids including Windows reserved names", () => {
    expect(sanitizeWorktreeRunId("Feature/Run 1")).toBe("feature-run-1");
    expect(sanitizeWorktreeRunId("CON")).toMatch(/^con-/);
    expect(sanitizeWorktreeRunId("aux.txt")).toMatch(/^aux-/);
    expect(sanitizeWorktreeRunId("com1")).toMatch(/^com1-/);
    expect(sanitizeWorktreeRunId("..")).not.toContain("..");
    expect(sanitizeWorktreeRunId("")).toMatch(/^[a-z0-9-]+$/);
  });

  it("accepts worktree paths inside the configured parent and rejects escapes", () => {
    const parent = canonicalizeWorkspacePath("/state/worktrees");
    const inside = canonicalizeWorkspacePath("/state/worktrees/run-1");
    expect(() => assertWorktreePathContained(inside, parent)).not.toThrow();
    expect(() =>
      assertWorktreePathContained(canonicalizeWorkspacePath("/state/other/run-1"), parent),
    ).toThrow(/worktree path|contain/i);
    expect(() =>
      assertWorktreePathContained(canonicalizeWorkspacePath("/state/worktrees-evil/run-1"), parent),
    ).toThrow(/worktree path|contain/i);
  });
});

describe("WorkspaceEvidenceSchema", () => {
  it("requires structured evidence fields", () => {
    const evidence = buildWorkspaceEvidence({
      headSha: "a".repeat(40),
      indexTreeSha: "b".repeat(40),
      statusDigest: "c".repeat(64),
      changedPaths: ["src/b.ts", "src/a.ts"],
    });
    const parsed = WorkspaceEvidenceSchema.parse(evidence);
    expect(parsed.changedPaths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(parsed.fingerprint).toBe(workspaceEvidenceFingerprint(evidence));
  });

  it("keeps fingerprints deterministic and versioned", () => {
    const fields = {
      headSha: "deadbeef",
      indexTreeSha: "cafebabe",
      statusDigest: "digest",
      changedPaths: ["z.ts", "a.ts"],
    };
    const first = workspaceEvidenceFingerprint(fields);
    const second = workspaceEvidenceFingerprint({
      ...fields,
      changedPaths: ["a.ts", "z.ts"],
    });
    expect(first).toBe(second);
    expect(first.startsWith(`v${WORKSPACE_EVIDENCE_FINGERPRINT_VERSION}:`)).toBe(true);
    expect(workspaceEvidenceFingerprint({ ...fields, headSha: "other" })).not.toBe(first);
  });
});

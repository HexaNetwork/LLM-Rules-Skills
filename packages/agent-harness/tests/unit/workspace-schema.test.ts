import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RunWorkspaceSchema,
  WorkspaceEvidenceSchema,
  WORKSPACE_EVIDENCE_FINGERPRINT_VERSION,
  buildWorkspaceEvidence,
  canonicalizeWorkspacePath,
  migrateRunWorkspace,
  workspaceEvidenceFingerprint,
} from "../../src/domain/workspace.js";

describe("RunWorkspaceSchema", () => {
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

  it("accepts a host-worktree record", () => {
    const parsed = RunWorkspaceSchema.parse({
      version: 1,
      kind: "host-worktree",
      controlRoot: "/repo",
      worktreePath: "/state/worktrees/run-abc",
      gitCommonDir: "/repo/.git",
      workspacePath: "/workspace",
      baseSha: "abc123",
      createdAt: "2026-08-10T12:00:00.000Z",
    });
    expect(parsed.kind).toBe("host-worktree");
    if (parsed.kind === "host-worktree") {
      expect(parsed.workspacePath).toBe("/workspace");
      expect(parsed.worktreePath).toBe("/state/worktrees/run-abc");
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

  it.each(["legacy-shared", "git-worktree", "docker-clone"])("rejects pre-cutover %s workspace records", (kind) => {
    expect(() =>
      migrateRunWorkspace(
        {
          version: 1,
          kind,
          controlRoot: "/project",
          createdAt: "2026-08-10T12:00:00.000Z",
        },
        { controlRoot: "/project" },
      ),
    ).toThrow(/pre-cutover workspaces/i);
  });

  it("canonicalizes stored paths on migration", () => {
    const migrated = migrateRunWorkspace(
      {
        version: 1,
        kind: "host-worktree",
        controlRoot: path.join("/project", "."),
        worktreePath: path.join("/state", "worktrees", "run-1"),
        gitCommonDir: path.join("/project", ".git"),
        workspacePath: "/workspace",
        baseSha: "abc123",
        createdAt: "2026-08-10T12:00:00.000Z",
      },
      { controlRoot: "/unused" },
    );
    expect(migrated.controlRoot).toBe(canonicalizeWorkspacePath("/project"));
    expect(migrated.kind).toBe("host-worktree");
    if (migrated.kind === "host-worktree") {
      expect(migrated.workspacePath).toBe("/workspace");
      expect(migrated.worktreePath).toBe(canonicalizeWorkspacePath("/state/worktrees/run-1"));
    }
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

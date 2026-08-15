import { describe, expect, it } from "vitest";
import path from "node:path";
import { HarnessConfigSchema } from "../../src/config/schema.js";
import {
  RunExecutionStateSchema,
  BundleImportStateSchema,
} from "../../src/domain/run-execution.js";
import {
  WORKER_WORKSPACE_PATH,
  resolveExecutionWorkspaceRoot,
  runExecutionStatePath,
  runBundleImportPath,
} from "../../src/application/paths.js";
import {
  HostWorktreeProvisioner,
  resolveWorkspaceProvisioner,
} from "../../src/workspace/index.js";

describe("execution path constants", () => {
  it("exposes the isolated worker workspace constant", () => {
    expect(WORKER_WORKSPACE_PATH).toBe("/workspace");
  });

  it("uses the host worktree path for host-owned commits", () => {
    expect(
      resolveExecutionWorkspaceRoot(
        {
          version: 1,
          kind: "host-worktree",
          controlRoot: "/repo",
          worktreePath: "/state/worktrees/run-1",
          gitCommonDir: "/repo/.git",
          workspacePath: "/workspace",
          baseSha: "abc",
          createdAt: "2026-08-15T12:00:00.000Z",
        },
        "/repo",
      ).replaceAll("\\", "/"),
    ).toMatch(/\/state\/worktrees\/run-1$/);
  });

  it("uses the host worktree path on the host", () => {
    expect(
      resolveExecutionWorkspaceRoot(
        {
          version: 1,
          kind: "host-worktree",
          controlRoot: "/repo",
          worktreePath: "/state/worktrees/run-1",
          gitCommonDir: "/repo/.git",
          workspacePath: "/workspace",
          baseSha: "abc",
          createdAt: "2026-08-10T12:00:00.000Z",
        },
        "/repo",
      ),
    ).toBe(path.resolve("/state/worktrees/run-1"));
  });

  it("places execution and transport metadata under the run directory", () => {
    expect(runExecutionStatePath("/state", "run-1").replaceAll("\\", "/")).toBe(
      "/state/runs/run-1/execution.json",
    );
    expect(runBundleImportPath("/state", "run-1").replaceAll("\\", "/")).toBe(
      "/state/runs/run-1/transport/import.json",
    );
  });
});

describe("run execution and transport schemas", () => {
  it("parses restartable execution.json and transport/import.json shapes", () => {
    expect(
      RunExecutionStateSchema.parse({
        version: 1,
        lifecycle: "running",
        containerName: "ah-proj-run-1",
        containerId: "ephemeral",
        hostPort: 4123,
        rpcTokenFingerprint: "abcd1234abcd1234",
        updatedAt: "2026-08-13T12:00:00.000Z",
      }).containerName,
    ).toBe("ah-proj-run-1");
    expect(
      BundleImportStateSchema.parse({
        version: 1,
        status: "seed-ready",
        seedBundleHash: "abc",
        updatedAt: "2026-08-13T12:00:00.000Z",
      }).status,
    ).toBe("seed-ready");
  });

  it("does not model retired runtime or bootstrap secret paths", () => {
    const current = {
      version: 1,
      lifecycle: "running",
      rpcTokenFingerprint: "abcd1234abcd1234",
      updatedAt: "2026-08-13T12:00:00.000Z",
    };
    expect(RunExecutionStateSchema.parse(current)).not.toHaveProperty("runtime");
    expect(() =>
      RunExecutionStateSchema.parse({ ...current, runtime: "local" }),
    ).toThrow();
    expect(() =>
      RunExecutionStateSchema.parse({
        ...current,
        rpcSecretRelativePath: "retired/rpc.token",
      }),
    ).toThrow();
  });
});

describe("resolveWorkspaceProvisioner", () => {
  it("returns the host worktree provisioner unconditionally", () => {
    const config = HarnessConfigSchema.parse({ repositoryRoot: "." });
    const store = {
      withWorkspaceAdminLock: async <T>(_h: unknown, work: () => Promise<T>) => work(),
    } as never;
    const provisioner = resolveWorkspaceProvisioner(config, {
      paths: {
        controlRoot: "/repo",
        stateRoot: "/state",
        workspaceRoot: "/repo",
      },
      store,
    });
    expect(provisioner).toBeInstanceOf(HostWorktreeProvisioner);
  });
});

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadRunConfig,
  loadRunWorkspace,
  runWorkspacePath,
} from "../../src/config/io.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

const dockerCloneWorkspace = (root: string) => ({
  version: 1 as const,
  kind: "docker-clone" as const,
  controlRoot: root.replaceAll("\\", "/"),
  containerName: "ah-project-run-1",
  workspaceVolumeName: "ah-ws-project-run-1",
  workspacePath: "/workspace",
  imageDigest: "sha256:abc",
  baseSha: "a".repeat(40),
  seedBundleHash: "sha256:bundle",
  generation: 0,
  baseBranch: "main",
  createdAt: new Date().toISOString(),
});

describe("loadRunWorkspace runDirectory override", () => {
  it("reads workspace.json from the worker run directory, not host stateDirectory/runs/<id>", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      // Simulate a frozen Docker run config that still points at a host path.
      stateDirectory: "C:\\Users\\host\\AppData\\Local\\agent-harness\\projects\\fake",
      repositoryRoot: root,
      git: {
        ...fixtureConfig(root).git,
        enabled: true,
      },
    });
    const runDir = path.join(root, "run-state-mount");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "workspace.json"),
      `${JSON.stringify(dockerCloneWorkspace(root), null, 2)}\n`,
      "utf8",
    );

    expect(runWorkspacePath(config, "run-1")).toMatch(/projects[/\\]fake[/\\]runs[/\\]run-1[/\\]workspace\.json$/i);
    expect(runWorkspacePath(config, "run-1", { runDirectory: runDir })).toBe(
      path.join(runDir, "workspace.json"),
    );

    await expect(loadRunWorkspace(config, "run-1")).rejects.toThrow(/workspace metadata is missing/i);

    const workspace = await loadRunWorkspace(config, "run-1", { runDirectory: runDir });
    expect(workspace.kind).toBe("docker-clone");
    if (workspace.kind === "docker-clone") {
      expect(workspace.imageDigest).toBe("sha256:abc");
    }
  });

  it("loads flat worker layout when stateDirectory is the run mount", async () => {
    const root = await fixtureRoot();
    const runDir = path.join(root, "run-state");
    await mkdir(runDir, { recursive: true });
    const config = fixtureConfig(root, {
      stateDirectory: runDir,
      repositoryRoot: root,
      git: {
        ...fixtureConfig(root).git,
        enabled: true,
      },
    });
    await writeFile(
      path.join(runDir, "workspace.json"),
      `${JSON.stringify(dockerCloneWorkspace(root), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8",
    );

    const workspace = await loadRunWorkspace(config, "run-1");
    expect(workspace.kind).toBe("docker-clone");
    const frozen = await loadRunConfig(config, "run-1");
    expect(frozen.stateDirectory).toBe(runDir);
  });
});

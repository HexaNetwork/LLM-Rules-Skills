import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { openRunHarness } from "../../src/application/run-engine-factory.js";
import { CONFIG_VERSION, configurationHash, HarnessConfigSchema } from "../../src/config/schema.js";
import { createRunState } from "../../src/domain.js";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";

describe("openRunHarness", () => {
  it("rejects missing workspace.json by default", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-orf-miss-"));
    const stateRoot = path.join(root, "state");
    const runId = "run-missing-ws";
    await mkdir(path.join(stateRoot, "runs", runId), { recursive: true });
    await writeFile(path.join(root, "package.json"), '{"name":"demo"}\n', "utf8");

    const config = HarnessConfigSchema.parse({
      repositoryRoot: root,
      stateDirectory: stateRoot,
      git: { enabled: true, baseBranch: "main" },
      knowledge: {
        sources: [{ path: "README.md" }],
        repositoryIntelligence: { enabled: false },
        guidance: { enabled: false, maxResults: 0, maxCharacters: 1 },
      },
    });
    await writeFile(
      path.join(stateRoot, "runs", runId, "config.json"),
      `${JSON.stringify({ ...config, configVersion: CONFIG_VERSION }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(stateRoot, "runs", runId, "state.json"),
      `${JSON.stringify(
        createRunState(runId, "idea", new Date().toISOString(), configurationHash(config), CONFIG_VERSION),
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(
      openRunHarness(config, runId, { backend: createFakeBackend({}) }, { validateWorkspace: false }),
    ).rejects.toThrow(/workspace metadata is missing/i);
  });

  it("opens a provisional engine when allowMissingWorkspace is set", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-orf-allow-"));
    const stateRoot = path.join(root, "state");
    const runId = "run-allow-miss";
    await mkdir(path.join(stateRoot, "runs", runId), { recursive: true });
    await writeFile(path.join(root, "package.json"), '{"name":"demo"}\n', "utf8");

    const config = HarnessConfigSchema.parse({
      repositoryRoot: root,
      stateDirectory: stateRoot,
      git: { enabled: true, baseBranch: "main" },
      knowledge: {
        sources: [{ path: "README.md" }],
        repositoryIntelligence: { enabled: false },
        guidance: { enabled: false, maxResults: 0, maxCharacters: 1 },
      },
    });
    await writeFile(
      path.join(stateRoot, "runs", runId, "config.json"),
      `${JSON.stringify({ ...config, configVersion: CONFIG_VERSION }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(stateRoot, "runs", runId, "state.json"),
      `${JSON.stringify(
        createRunState(runId, "idea", new Date().toISOString(), configurationHash(config), CONFIG_VERSION),
        null,
        2,
      )}\n`,
      "utf8",
    );

    const opened = await openRunHarness(
      config,
      runId,
      { backend: createFakeBackend({}) },
      { validateWorkspace: false, allowMissingWorkspace: true },
    );

    expect(opened.config.execution).not.toHaveProperty("runtime");
    expect(opened.engine).toBeDefined();
    expect(opened.workspace.controlRoot).toBeTruthy();
  });

  it("loads workspace via store.runDirectory when projectConfig stateDirectory is wrong", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-orf-store-"));
    const stateRoot = path.join(root, "state");
    const runId = "run-store-path";
    const runDir = path.join(stateRoot, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(root, "package.json"), '{"name":"demo"}\n', "utf8");

    const realConfig = HarnessConfigSchema.parse({
      repositoryRoot: root,
      stateDirectory: stateRoot,
      git: { enabled: true, baseBranch: "main" },
      knowledge: {
        sources: [{ path: "README.md" }],
        repositoryIntelligence: { enabled: false },
        guidance: { enabled: false, maxResults: 0, maxCharacters: 1 },
      },
    });
    const wrongProjectConfig = HarnessConfigSchema.parse({
      ...realConfig,
      // Hybrid stamp failure: control root correct, stateDirectory relative → repo-local.
      stateDirectory: ".",
    });

    await writeFile(
      path.join(runDir, "config.json"),
      `${JSON.stringify({ ...realConfig, configVersion: CONFIG_VERSION }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "state.json"),
      `${JSON.stringify(
        createRunState(runId, "idea", new Date().toISOString(), configurationHash(realConfig), CONFIG_VERSION),
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "workspace.json"),
      `${JSON.stringify(
        {
          version: 1,
          kind: "docker-clone",
          controlRoot: root.replaceAll("\\", "/"),
          containerName: "ah-project-run-store-path",
          workspaceVolumeName: "ah-ws-project-run-store-path",
          workspacePath: "/workspace",
          imageDigest: "sha256:abc",
          baseSha: "a".repeat(40),
          seedBundleHash: "sha256:bundle",
          generation: 0,
          baseBranch: "main",
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const { RunStore } = await import("../../src/store.js");
    const store = new RunStore(realConfig, stateRoot);

    await expect(
      openRunHarness(
        wrongProjectConfig,
        runId,
        { backend: createFakeBackend({}), store },
        { validateWorkspace: false },
      ),
    ).resolves.toMatchObject({
      workspace: { kind: "docker-clone" },
    });
  });
});

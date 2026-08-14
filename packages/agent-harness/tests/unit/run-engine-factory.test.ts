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
      execution: { runtime: "docker" },
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
      openRunHarness(config, runId, { backend: createFakeBackend({}) }, { validateWorktree: false }),
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
      execution: { runtime: "docker" },
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
      { validateWorktree: false, allowMissingWorkspace: true },
    );

    expect(opened.config.execution.runtime).toBe("docker");
    expect(opened.engine).toBeDefined();
    expect(opened.workspace.controlRoot).toBeTruthy();
  });
});

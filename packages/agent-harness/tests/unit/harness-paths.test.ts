import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApplicationContext } from "../../src/application/application-context.js";
import { createApplicationDependencies } from "../../src/application/dependencies.js";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import { createFakeBackend } from "../../src/agent.js";
import { configurationHash, HarnessConfigSchema } from "../../src/config.js";
import { RunStore } from "../../src/store.js";
import { buildFixtureConfig } from "../testkit/project-fixture.js";

describe("resolveHarnessPaths", () => {
  it("sets workspaceRoot equal to controlRoot and derives stateRoot from config", () => {
    const root = path.resolve("/tmp/harness-control");
    const config = buildFixtureConfig(root, { stateDirectory: ".agent-harness" });
    const paths = resolveHarnessPaths(config);

    expect(paths.controlRoot).toBe(path.resolve(root));
    expect(paths.workspaceRoot).toBe(paths.controlRoot);
    expect(paths.stateRoot).toBe(path.resolve(root, ".agent-harness"));
  });

  it("resolves an absolute stateDirectory without nesting under controlRoot", () => {
    const controlRoot = path.resolve("/tmp/harness-control");
    const stateRoot = path.resolve("/tmp/harness-state");
    const config = buildFixtureConfig(controlRoot, { stateDirectory: stateRoot });
    const paths = resolveHarnessPaths(config);

    expect(paths.controlRoot).toBe(controlRoot);
    expect(paths.workspaceRoot).toBe(controlRoot);
    expect(paths.stateRoot).toBe(stateRoot);
  });

  it("points workspaceRoot at a git-worktree path when workspace metadata is provided", () => {
    const controlRoot = path.resolve("/tmp/harness-control");
    const worktreePath = path.resolve("/tmp/harness-state/worktrees/run-1");
    const config = buildFixtureConfig(controlRoot, { stateDirectory: ".agent-harness" });
    const paths = resolveHarnessPaths(config, {
      version: 1,
      kind: "git-worktree",
      controlRoot,
      worktreePath,
      createdAt: "2026-08-10T00:00:00.000Z",
    });

    expect(paths.controlRoot).toBe(controlRoot);
    expect(paths.workspaceRoot).toBe(worktreePath);
  });
});

describe("HarnessPaths composition", () => {
  it("exposes paths on ApplicationContext and wires RunStore to stateRoot", () => {
    const root = path.resolve("/tmp/harness-compose");
    const config = buildFixtureConfig(root);
    const expected = resolveHarnessPaths(config);
    const ctx = new ApplicationContext(config, { backend: createFakeBackend() });

    expect(ctx.paths).toEqual(expected);
    expect(ctx.paths.workspaceRoot).toBe(ctx.paths.controlRoot);
    expect(ctx.store.root).toBe(expected.stateRoot);
  });

  it("passes stateRoot into RunStore from createApplicationDependencies", () => {
    const root = path.resolve("/tmp/harness-deps");
    const config = buildFixtureConfig(root, { stateDirectory: "custom-state" });
    const paths = resolveHarnessPaths(config);
    const deps = createApplicationDependencies(config, { backend: createFakeBackend() });

    expect(deps.paths).toEqual(paths);
    expect(deps.store.root).toBe(paths.stateRoot);
    expect(deps.store).toBeInstanceOf(RunStore);
  });
});

describe("configurationHash runtime path stability", () => {
  it("omits repositoryRoot, stateDirectory, and sharedIndexDirectory from the hash", () => {
    const base = HarnessConfigSchema.parse({
      repositoryRoot: "/project-a",
      stateDirectory: ".agent-harness",
      knowledge: { sharedIndexDirectory: "shared-a" },
      workflow: { tdd: true },
    });
    const relocated = {
      ...base,
      repositoryRoot: "/project-b",
      stateDirectory: "/absolute/state",
      knowledge: { ...base.knowledge, sharedIndexDirectory: "shared-b" },
    };

    expect(configurationHash(relocated)).toBe(configurationHash(base));
  });
});

import { describe, expect, it, vi } from "vitest";
import { runInitialSetupThenAdvance } from "../../src/application/run-setup.js";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import type { RunStore } from "../../src/store.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

describe("initial repository intelligence setup", () => {
  it("prepares neutral artifacts before document refresh and advance", async () => {
    const root = await fixtureRoot();
    const base = fixtureConfig(root);
    const config = fixtureConfig(root, {
      knowledge: {
        ...base.knowledge,
        repositoryIntelligence: {
          ...base.knowledge.repositoryIntelligence,
          enabled: true,
        },
      },
    });
    const order: string[] = [];
    const state = { runId: "run-1", phase: "new" };
    const store = {
      load: vi.fn(async () => state),
      withWorkspaceAdminLock: vi.fn(async (_holder, work) => work()),
      withSharedIndexLock: vi.fn(async (_holder, work) => work()),
      record: vi.fn(),
    } as unknown as RunStore;

    await runInitialSetupThenAdvance({
      runId: "run-1",
      config,
      store,
      paths: resolveHarnessPaths(config),
      git: {
        async ensureRepositoryIntelligenceArtifactsIgnored() {
          order.push("ignore");
        },
      },
      knowledge: {
        async prepareRepositoryIntelligence() {
          order.push("prepare");
        },
        async refresh() {
          order.push("documents");
        },
      },
      async advance() {
        order.push("advance");
      },
    });

    expect(order).toEqual(["ignore", "prepare", "documents", "advance"]);
  });

  it("still runs repository intelligence when invoked inside a worker (/workspace exists)", async () => {
    // Host-side docker setup must not call this helper against /workspace; the worker RPC
    // initial_setup path uses this helper where /workspace is a real mount.
    const root = await fixtureRoot();
    const base = fixtureConfig(root);
    const config = fixtureConfig(root, {
      knowledge: {
        ...base.knowledge,
        repositoryIntelligence: {
          ...base.knowledge.repositoryIntelligence,
          enabled: true,
        },
      },
    });
    const order: string[] = [];
    const state = { runId: "run-1", phase: "new" };
    const store = {
      load: vi.fn(async () => state),
      withWorkspaceAdminLock: vi.fn(async (_holder, work) => work()),
      withSharedIndexLock: vi.fn(async (_holder, work) => work()),
      record: vi.fn(),
    } as unknown as RunStore;
    const paths = resolveHarnessPaths(config);
    paths.workspaceRoot = "/workspace";

    await runInitialSetupThenAdvance({
      runId: "run-1",
      config,
      store,
      paths,
      git: {
        async ensureRepositoryIntelligenceArtifactsIgnored() {
          order.push("ignore");
        },
      },
      knowledge: {
        async prepareRepositoryIntelligence() {
          order.push("prepare");
        },
        async refresh() {
          order.push("documents");
        },
      },
      async advance() {
        order.push("advance");
      },
    });

    expect(order).toEqual(["ignore", "prepare", "documents", "advance"]);
  });
});

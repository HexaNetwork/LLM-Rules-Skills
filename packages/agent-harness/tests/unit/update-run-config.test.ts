import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveHarnessPaths } from "../../src/application/paths.js";
import { updateRunConfig } from "../../src/application/update-run-config.js";
import { ApplicationContext } from "../../src/application/application-context.js";
import {
  CONFIG_VERSION,
  configurationHash,
  normalizeFrozenRunConfig} from "../../src/config.js";
import { createRunState, type RunState } from "../../src/domain.js";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import { RunStore } from "../../src/store.js";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";
import { fixtureConfig } from "../helpers.js";

describe("updateRunConfig", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = undefined;
    }
  });

  async function prepareRun(options?: {
    fault?: NonNullable<RunStore["configTransitionFault"]>;
  }): Promise<{
    ctx: ApplicationContext;
    state: RunState;
    store: RunStore;
    runId: string;
    config: ReturnType<typeof fixtureConfig>;
  }> {
    fixture = await createProjectFixture();
    const config = fixtureConfig(fixture.root, {
      workflow: { maxRunTokens: 100 } as never});
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
    if (options?.fault) store.configTransitionFault = options.fault;
    await store.initialize();
    const runId = "cfg-txn";
    const hash = configurationHash(config);
    const state = {
      ...createRunState(runId, "idea", new Date().toISOString(), hash, CONFIG_VERSION),
      configRevision: 0};
    await store.create(state);
    await store.writeJson(runId, "config.json", { ...config, configVersion: CONFIG_VERSION });
    const ctx = new ApplicationContext(structuredClone(config), {
      store,
      backend: createFakeBackend({})});
    return { ctx, state, store, runId, config };
  }

  it("persists a validated policy patch, bumps configRevision, and audits run.config_updated", async () => {
    const { ctx, state, store, runId } = await prepareRun();

    const result = await updateRunConfig(
      ctx,
      runId,
      state.configRevision ?? 0,
      { workflow: { maxRunTokens: 500 } },
      { reason: "budget" },
    );

    expect(result.revision).toBe(1);
    expect(result.changedPaths).toEqual(
      expect.arrayContaining(["workflow.maxRunTokens"]),
    );
    expect(result.nextHash).not.toBe(result.previousHash);
    expect(result.state.configurationHash).toBe(result.nextHash);
    expect(result.state.configRevision).toBe(1);
    expect(ctx.config.workflow.maxRunTokens).toBe(500);

    const frozen = normalizeFrozenRunConfig(await store.readJson(runId, "config.json"));
    expect(frozen.workflow.maxRunTokens).toBe(500);
    expect(configurationHash(frozen)).toBe(result.nextHash);

    const events = await store.readText(runId, "events.jsonl");
    expect(events).toContain("run.config_updated");
    expect(events).toContain('"reason":"budget"');
    expect(events).toContain(`"revision":1`);
  });

  it("rejects a stale expectedRevision without writing config", async () => {
    const { ctx, store, runId, config } = await prepareRun();
    await updateRunConfig(ctx, runId, 0, { workflow: { maxRunTokens: 200 } }, { reason: "budget" });
    const before = await store.readJson(runId, "config.json");

    await expect(
      updateRunConfig(ctx, runId, 0, { workflow: { maxRunTokens: 300 } }, { reason: "budget" }),
    ).rejects.toThrow(/configRevision/);

    const after = await store.readJson(runId, "config.json");
    expect(after).toEqual(before);
    expect(normalizeFrozenRunConfig(after).workflow.maxRunTokens).toBe(200);
    expect(ctx.config.workflow.maxRunTokens).toBe(200);
    void config;
  });

  it.each([
    "after_journal",
    "after_config",
    "after_state",
    "after_event"] as const)(
    "recovers a consistent config/hash pair after a crash at %s",
    async (fault) => {
      const { ctx, state, store, runId, config } = await prepareRun({ fault });
      const previousHash = state.configurationHash;

      await expect(
        updateRunConfig(
          ctx,
          runId,
          0,
          { workflow: { maxRunTokens: 900 } },
          { reason: "budget" },
        ),
      ).rejects.toThrow(/fault injection/);

      // Simulate process death: in-memory ctx must not be trusted until reload.
      ctx.config.workflow.maxRunTokens = config.workflow.maxRunTokens;

      const recovered = await store.load(runId);
      const frozen = normalizeFrozenRunConfig(await store.readJson(runId, "config.json"));
      const frozenHash = configurationHash(frozen);

      expect(frozen.workflow.maxRunTokens).toBe(900);
      expect(recovered.configurationHash).toBe(frozenHash);
      expect(recovered.configurationHash).not.toBe(previousHash);
      expect(recovered.configRevision).toBe(1);

      const events = await readFile(
        path.join(store.runDirectory(runId), "events.jsonl"),
        "utf8",
      );
      expect(events.match(/run\.config_updated/g)).toHaveLength(1);

      // Journal must not remain as an unexplained pending write.
      await expect(
        readFile(path.join(store.runDirectory(runId), "transition.pending.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("does not leave a durable config write without a journaled matching state hash", async () => {
    const { ctx, store, runId, config } = await prepareRun({ fault: "after_config" });
    const beforeState = await store.load(runId);

    await expect(
      updateRunConfig(ctx, runId, 0, { workflow: { maxRunTokens: 777 } }, { reason: "budget" }),
    ).rejects.toThrow(/fault injection/);

    // Before recovery: config may already be new, but the journal explains it.
    const pending = JSON.parse(
      await readFile(path.join(store.runDirectory(runId), "transition.pending.json"), "utf8"),
    ) as {
      state: RunState;
      config: { workflow: { maxRunTokens: number } };
    };
    const onDiskConfig = normalizeFrozenRunConfig(await store.readJson(runId, "config.json"));
    const onDiskState = JSON.parse(
      await readFile(path.join(store.runDirectory(runId), "state.json"), "utf8"),
    ) as RunState;

    expect(onDiskConfig.workflow.maxRunTokens).toBe(777);
    expect(onDiskState.configurationHash).toBe(beforeState.configurationHash);
    expect(pending.state.configurationHash).toBe(configurationHash(onDiskConfig));
    expect(pending.config.workflow.maxRunTokens).toBe(777);
    void config;
  });
});

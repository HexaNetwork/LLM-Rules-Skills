import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import {
  bootProfile,
  dumpProfileConfig,
  validateProfileDefinition,
  type ProfileDefinition,
} from "../../src/vnext/boot/boot-profile.js";
import { securityPolicyPlugin } from "../../src/vnext/plugins/security-policy.js";
import { immutableEnvironmentPlugin } from "../../src/vnext/plugins/immutable-environment.js";
import {
  RunLifecycleCoordinator,
  type LifecycleStageHandler,
} from "../../src/vnext/plugins/run-lifecycle.js";
import type {
  HostLifecycleState,
  LifecycleStage,
} from "../../src/vnext/services/contracts.js";
import { profileForDump } from "../../src/vnext/profiles/index.js";

describe("Cordis vNext profiles", () => {
  it("boots required services and disposes effect-owned providers", async () => {
    let disposed = false;
    const webPlugin = (ctx: Context) => {
      ctx.provide("webServer", {
        origin: "http://127.0.0.1:0",
        close: async () => undefined,
      });
      return () => {
        disposed = true;
      };
    };
    const profile: ProfileDefinition = {
      name: "test-host",
      production: true,
      hmr: false,
      requiredServices: ["securityPolicy", "webServer"],
      rows: [
        {
          id: "security",
          plugin: securityPolicyPlugin,
          provides: ["securityPolicy"],
          trusted: true,
        },
        {
          id: "web",
          plugin: webPlugin,
          provides: ["webServer"],
          trusted: true,
        },
      ],
    };

    const booted = await bootProfile(profile);
    expect(booted.ctx.webServer.origin).toBe("http://127.0.0.1:0");
    expect(booted.diagnostics.every((item) => item.status === "active")).toBe(true);
    await booted.dispose();
    expect(disposed).toBe(true);
  });

  it("fails closed for duplicate production security providers", () => {
    const profile = profileForDump("host");
    profile.rows.push({
      id: "security-duplicate",
      plugin: securityPolicyPlugin,
      provides: ["securityPolicy"],
      trusted: true,
    });
    expect(() => validateProfileDefinition(profile)).toThrow(/duplicate providers/i);
  });

  it("dumps stable rows with credential redaction", () => {
    const profile = profileForDump("host");
    profile.rows[0]!.config = { credential: "do-not-print", nested: { apiKey: "hidden" } };
    const dump = dumpProfileConfig(profile);
    expect(dump).toContain("[REDACTED]");
    expect(dump).not.toContain("do-not-print");
    expect(dump).not.toContain("hidden");
  });

  it("resolves only the configured immutable image digest", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const runtimePlugin = (ctx: Context) =>
      ctx.provide("containerRuntime", {
        ensureImage: async (reference: string) => ({ reference, digest }),
        createVolume: async () => undefined,
        start: async () => ({ containerId: "worker" }),
        stop: async () => undefined,
        removeContainer: async () => undefined,
        removeVolume: async () => undefined,
      });
    const booted = await bootProfile({
      name: "immutable-test",
      production: false,
      hmr: false,
      requiredServices: ["containerRuntime", "environment"],
      rows: [
        {
          id: "runtime",
          plugin: runtimePlugin,
          provides: ["containerRuntime"],
        },
        {
          id: "environment",
          plugin: immutableEnvironmentPlugin,
          config: { image: `agent-harness-worker@${digest}` },
          provides: ["environment"],
        },
      ],
    });
    await expect(booted.ctx.environment.resolve()).resolves.toEqual({
      reference: `agent-harness-worker@${digest}`,
      digest,
    });
    await booted.dispose();
  });
});

describe("Cordis host lifecycle", () => {
  it("validates each idempotent stage and resumes from the last durable boundary", async () => {
    const durable = new Map<string, HostLifecycleState>();
    const completed = new Set<LifecycleStage>();
    const apply = vi.fn(async (_runId: string, stage: LifecycleStage) => {
      completed.add(stage);
    });
    const handlers = Object.fromEntries(
      [
        "image_ready",
        "volume_ready",
        "workspace_seeded",
        "worker_starting",
        "worker_ready",
        "running",
        "export_ready",
        "settled",
      ].map((stage) => [
        stage,
        {
          inspect: async () => completed.has(stage as LifecycleStage),
          apply: async (runId: string) => apply(runId, stage as LifecycleStage),
        } satisfies LifecycleStageHandler,
      ]),
    );
    const emitted: string[] = [];
    const ctx = {
      emit: (name: string) => emitted.push(name),
    } as unknown as Context;
    const coordinator = new RunLifecycleCoordinator(ctx, {
      load: async (runId) => durable.get(runId),
      save: async (state) => {
        durable.set(state.runId, state);
      },
      listRecoverableRunIds: async () => ["run-1"],
      handlers,
    });

    await coordinator.enqueue("run-1");
    expect(durable.get("run-1")?.stage).toBe("settled");
    expect(apply).toHaveBeenCalledTimes(8);
    await coordinator.recover();
    expect(apply).toHaveBeenCalledTimes(8);
    expect(emitted).toContain("run/settled");
  });

  it("recovers deterministically after every persisted lifecycle boundary", async () => {
    const stages: LifecycleStage[] = [
      "created",
      "image_ready",
      "volume_ready",
      "workspace_seeded",
      "worker_starting",
      "worker_ready",
      "running",
      "export_ready",
      "settled",
    ];
    for (const [boundaryIndex, boundary] of stages.entries()) {
      const durable = new Map<string, HostLifecycleState>([
        ["restart-run", { runId: "restart-run", stage: boundary, revision: boundaryIndex }],
      ]);
      const completed = new Set(stages.slice(0, boundaryIndex + 1));
      const applied: LifecycleStage[] = [];
      const handlers = Object.fromEntries(
        stages.slice(1).map((stage) => [
          stage,
          {
            inspect: async () => completed.has(stage),
            apply: async () => {
              applied.push(stage);
              completed.add(stage);
            },
          } satisfies LifecycleStageHandler,
        ]),
      );
      const restarted = new RunLifecycleCoordinator(
        { emit: () => undefined } as unknown as Context,
        {
          load: async (runId) => durable.get(runId),
          save: async (state) => {
            durable.set(state.runId, state);
          },
          listRecoverableRunIds: async () => ["restart-run"],
          handlers,
        },
      );

      await restarted.recover();

      expect(durable.get("restart-run")?.stage).toBe("settled");
      expect(applied).toEqual(stages.slice(boundaryIndex + 1));
    }
  });

  it("persists a retryable failed-stage record without advancing", async () => {
    let state: HostLifecycleState | undefined;
    const coordinator = new RunLifecycleCoordinator(
      { emit: () => undefined } as unknown as Context,
      {
        load: async () => state,
        save: async (next) => {
          state = next;
        },
        listRecoverableRunIds: async () => [],
        handlers: {
          image_ready: {
            inspect: async () => false,
            apply: async () => {
              throw new Error("registry unavailable");
            },
            retryable: () => true,
          },
        },
      },
    );

    await expect(coordinator.enqueue("run-2")).rejects.toThrow("registry unavailable");
    expect(state?.stage).toBe("created");
    expect(state?.failure).toMatchObject({
      stage: "image_ready",
      retryable: true,
      lastSuccessfulStage: "created",
    });
  });
});

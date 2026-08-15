import { describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import { reportedTotal } from "../../src/infrastructure/agents/usage.js";
import type { AgentBackend } from "../../src/infrastructure/agents/types.js";
import { ApplicationContext } from "../../src/application/application-context.js";
import { accrueRunUsage } from "../../src/application/usage-ledger.js";
import { CONFIG_VERSION, configurationHash } from "../../src/config/schema.js";
import { createRunState, type BuildTask, type RunState } from "../../src/domain.js";
import { WorkerHarnessRuntime } from "../../src/application/harness-engine.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

describe("reportedTotal", () => {
  it("derives input + output instead of trusting a provider total that double-counts cache reads", () => {
    // Cursor SDK usage: inputTokens already includes cacheReadTokens, but its
    // totalTokens = input + output + cacheRead + cacheWrite counts them again.
    expect(
      reportedTotal({
        inputTokens: 320_653,
        outputTokens: 6_217,
        totalTokens: 598_134}),
    ).toBe(326_870);
  });

  it("falls back to the provider total when components are missing", () => {
    expect(reportedTotal({ totalTokens: 105 })).toBe(105);
    expect(reportedTotal({ inputTokens: 100, totalTokens: 150 })).toBe(150);
  });

  it("returns undefined when nothing is reported", () => {
    expect(reportedTotal(undefined)).toBeUndefined();
    expect(reportedTotal({})).toBeUndefined();
  });
});

describe("run usage accrual and cost ceiling", () => {
  it("accrues config-fixer recovery usage immediately and invokes it without retrieval or tools", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { ...fixtureConfig(root).agent, promptBuilder: true },
      knowledge: {
        ...fixtureConfig(root).knowledge,
        guidance: {
          ...fixtureConfig(root).knowledge.guidance,
          enabled: true,
          assignments: undefined}}});
    let observedRequest: Parameters<AgentBackend["run"]>[0] | undefined;
    const backend: AgentBackend = {
      async run(request) {
        observedRequest = request;
        return {
          output: {
            summary: "Recognize the nested test directory.",
            configPatch: { workflow: { testPathPatterns: ["tests/**", "**/src/main/test/**"] } }},
          providerSessionId: "config-fixer-agent",
          providerRunId: "config-fixer-run",
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 60,
          totalTokens: 120};
      }};
    const engine = new WorkerHarnessRuntime(config, { backend });
    const hash = configurationHash(config);
    const runId = "config-fixer-usage";
    const state: RunState = {
      ...createRunState(runId, "idea", new Date().toISOString(), hash, CONFIG_VERSION),
      phase: "blocked",
      blockedFrom: "executing",
      blockedKind: "config",
      blockedRetriable: false,
      failure: "Test command could not be launched: ./gradlew test"};
    await engine.store.initialize();
    await engine.store.create(state);
    await engine.store.writeJson(runId, "config.json", { ...config, configVersion: CONFIG_VERSION });

    const proposed = await engine.proposeFix(runId, "Keep the test and repair the path pattern.");

    expect(proposed.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 60,
      totalTokens: 120,
      invocations: 1,
      sessionsRead: 1});
    expect(observedRequest?.allowTools).toBe(false);
    expect(observedRequest?.prompt).not.toContain("SELECTED GUIDANCE");
    expect(observedRequest?.prompt).toContain("Return exactly one raw JSON object");
  });

  it("blocks with blockedKind budget before the next step when maxRunTokens is exceeded", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: {
        ...fixtureConfig(root).workflow,
        maxRunTokens: 100},
      commands: { verification: [{ id: "test", command: 'node -e "process.exit(0)"', timeoutMs: 600_000 }] }});
    let implementerCalls = 0;
    const backend = createFakeBackend({
      implementer: () => {
        implementerCalls += 1;
        return { summary: "built", changedFiles: [`src/a${implementerCalls}.ts`] };
      },
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: a", body: "" })});
    const engine = new WorkerHarnessRuntime(config, { backend });
    const tasks: BuildTask[] = [1, 2].map((index) => ({
      id: `t${index}`,
      title: `Ship ${index}`,
      description: `Do ${index}`,
      acceptanceCriteria: ["works"],
      affectedPaths: [],
      blockedBy: [],
      status: "pending" as const,
      step: "pending" as const,
      attempts: { implementation: 0, review: 0 },
      evidence: [],
      testPaths: [],
      changedFiles: []}));
    let state: RunState = {
      ...createRunState("token-ceiling", "idea", new Date().toISOString(), "hash", CONFIG_VERSION),
      phase: "executing",
      tasks,
      reflectBrief: { draft: "d", confirmed: "confirmed", confirmedAt: new Date().toISOString() },
      configurationHash: configurationHash(config)};
    await engine.store.initialize();
    await engine.store.create(state);
    await engine.store.writeJson(state.runId, "state.json", state);
    await engine.store.writeJson(state.runId, "config.json", {
      ...config,
      configVersion: CONFIG_VERSION});
    // Pretend a prior step already spent past the ceiling.
    await engine.store.writeJson(state.runId, "sessions/prior.json", {
      sessionId: "prior",
      role: "implementer",
      model: "capable-model",
      status: "completed",
      usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 }});

    state = await engine.advance(state.runId);

    expect(state.phase).toBe("blocked");
    expect(state.blockedKind).toBe("budget");
    expect(state.blockedRetriable).toBe(false);
    expect(implementerCalls).toBe(0);
    expect(state.usage.totalTokens).toBeGreaterThan(100);
  });

  it("recomputes the same usage totals when accrued twice from unchanged session files", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      models: {
        small: "small-model",
        capable: "capable-model",
        roles: {},
        pricing: {
          "capable-model": {
            inputPerMillion: 1,
            outputPerMillion: 2,
            cacheReadPerMillion: 0.1,
            cacheWritePerMillion: 1.25}}}});
    const engine = new WorkerHarnessRuntime(config, { backend: createFakeBackend({}) });
    const hash = configurationHash(config);
    let state: RunState = {
      ...createRunState("usage-idempotent", "idea", new Date().toISOString(), hash, CONFIG_VERSION),
      phase: "executing",
      configurationHash: hash};
    await engine.store.initialize();
    await engine.store.create(state);
    await engine.store.writeJson(state.runId, "state.json", state);
    await engine.store.writeJson(state.runId, "config.json", {
      ...config,
      configVersion: CONFIG_VERSION});
    await engine.store.writeJson(state.runId, "sessions/a.json", {
      sessionId: "a",
      role: "implementer",
      model: "capable-model",
      status: "completed",
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 200_000,
        cacheWriteTokens: 50_000,
        totalTokens: 2_000_000, // provider double-count — ignored when components present
      }});
    await engine.store.writeJson(state.runId, "sessions/b.json", {
      sessionId: "b",
      role: "reviewer",
      model: "capable-model",
      status: "completed",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }});

    const ctx = new ApplicationContext(config, {
      backend: createFakeBackend({}),
      store: engine.store});
    const first = await accrueRunUsage(ctx, await engine.store.load(state.runId));
    const second = await accrueRunUsage(ctx, first);

    expect(second.usage).toEqual(first.usage);
    expect(first.usage.totalTokens).toBe(1_500_150);
    expect(first.usage.inputTokens).toBe(1_000_100);
    expect(first.usage.outputTokens).toBe(500_050);
    expect(first.usage.invocations).toBe(2);
    expect(first.usage.sessionsRead).toBe(2);
    // 1M*1 + 0.5M*2 + 0.2M*0.1 + 0.05M*1.25 + tiny second session
    expect(first.usage.costUsd).toBeCloseTo(1 + 1 + 0.02 + 0.0625 + 0.0001 + 0.0001, 5);
  });

  it("rewrites frozen maxRunTokens on force-retry and re-stamps configurationHash", async () => {
    const root = await fixtureRoot();
    const frozenPatterns = ["tests/**"];
    const config = fixtureConfig(root, {
      workflow: {
        ...fixtureConfig(root).workflow,
        maxRunTokens: 100,
        testPathPatterns: frozenPatterns}});
    const liveConfig = {
      ...config,
      workflow: {
        ...config.workflow,
        testPathPatterns: ["modules/**/src/test/**"]}};
    const engine = new WorkerHarnessRuntime(liveConfig, { backend: createFakeBackend({}) });
    const hash = configurationHash(config);
    let state: RunState = {
      ...createRunState("raise-ceiling", "idea", new Date().toISOString(), hash, CONFIG_VERSION),
      phase: "blocked",
      blockedFrom: "executing",
      blockedKind: "budget",
      blockedRetriable: false,
      failure: "Run exceeded maxRunTokens: observed 120 > limit 100"};
    await engine.store.initialize();
    await engine.store.create(state);
    await engine.store.writeJson(state.runId, "state.json", state);
    await engine.store.writeJson(state.runId, "config.json", {
      ...config,
      configVersion: CONFIG_VERSION});

    state = await engine.retry(state.runId, { force: true, maxRunTokens: 500 });

    expect(state.phase).toBe("executing");
    expect(state.blockedKind).toBeUndefined();
    expect(engine.config.workflow.maxRunTokens).toBe(500);
    const frozen = (await engine.store.readJson(state.runId, "config.json")) as {
      workflow: { maxRunTokens: number; testPathPatterns?: string[] };
    };
    expect(frozen.workflow.maxRunTokens).toBe(500);
    expect(frozen.workflow.testPathPatterns).toEqual(frozenPatterns);
    expect(state.configurationHash).toBe(configurationHash(engine.config));
  });

  it("counts tokens for an unpriced model but contributes 0 to costUsd", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      models: {
        small: "small-model",
        capable: "capable-model",
        roles: {},
        pricing: {
          "priced-model": { inputPerMillion: 10, outputPerMillion: 20 }}}});
    const engine = new WorkerHarnessRuntime(config, { backend: createFakeBackend({}) });
    const hash = configurationHash(config);
    let state: RunState = {
      ...createRunState("unpriced-model", "idea", new Date().toISOString(), hash, CONFIG_VERSION),
      phase: "executing",
      configurationHash: hash};
    await engine.store.initialize();
    await engine.store.create(state);
    await engine.store.writeJson(state.runId, "state.json", state);
    await engine.store.writeJson(state.runId, "config.json", {
      ...config,
      configVersion: CONFIG_VERSION});
    await engine.store.writeJson(state.runId, "sessions/unpriced.json", {
      sessionId: "unpriced",
      role: "implementer",
      model: "capable-model",
      status: "completed",
      usage: { inputTokens: 2_000, outputTokens: 500, totalTokens: 2_500 }});

    state = await accrueRunUsage(
      new ApplicationContext(config, { backend: createFakeBackend({}), store: engine.store }),
      await engine.store.load(state.runId),
    );

    expect(state.usage.totalTokens).toBe(2_500);
    expect(state.usage.inputTokens).toBe(2_000);
    expect(state.usage.outputTokens).toBe(500);
    expect(state.usage.costUsd).toBe(0);
    expect(state.usage.costIsLowerBound).toBe(true);
  });
});

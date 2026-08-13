import { describe, expect, it, vi } from "vitest";
import { RepositoryIntelligenceBroker } from "../../src/infrastructure/repository-intelligence/broker.js";
import type {
  RepositoryIntelligenceAdapter,
  RepositoryIntelligenceRequest,
} from "../../src/infrastructure/repository-intelligence/types.js";

describe("RepositoryIntelligenceBroker", () => {
  it("uses ordered first-success fallback and audits every attempt", async () => {
    const first = adapter("gitnexus", async () => ({
      shapedQuery: "SettlementWindow",
      usedFallback: false,
      skippedReason: "no-matches",
    }));
    const second = adapter("codegraph", async () => ({
      artifact: {
        providerId: "codegraph",
        source: "repository:codegraph",
        title: "Repository relationships",
        excerpt: "SettlementWindow -> Ledger",
        score: 0,
        generation: "g1",
      },
      shapedQuery: "SettlementWindow",
      usedFallback: false,
    }));
    const broker = new RepositoryIntelligenceBroker({
      adapters: [first, second],
      routes: { search: ["gitnexus", "codegraph"] },
    });

    const result = await broker.retrieve(request());

    expect(result.result?.providerId).toBe("codegraph");
    expect(result.attempts.map((attempt) => [attempt.providerId, attempt.outcome])).toEqual([
      ["gitnexus", "miss"],
      ["codegraph", "success"],
    ]);
  });

  it("short-circuits after the first usable result", async () => {
    const first = adapter("gitnexus", async () => ({
      artifact: {
        providerId: "gitnexus",
        source: "repository:gitnexus",
        title: "Repository relationships",
        excerpt: "hit",
        score: 0,
        generation: "g1",
      },
      shapedQuery: "query",
      usedFallback: false,
    }));
    const second = adapter("codegraph", vi.fn());
    const broker = new RepositoryIntelligenceBroker({
      adapters: [first, second],
      routes: { search: ["gitnexus", "codegraph"] },
    });

    await expect(broker.retrieve(request())).resolves.toMatchObject({
      result: { providerId: "gitnexus" },
    });
    expect(second.retrieve).not.toHaveBeenCalled();
  });

  it("refreshes a stale fallback lazily under the shared lock", async () => {
    const locks: string[] = [];
    const primary = adapter("gitnexus", async () => ({
      shapedQuery: "query",
      usedFallback: false,
      skippedReason: "no-matches",
    }));
    const fallback = adapter("codegraph", async () => ({
      artifact: {
        providerId: "codegraph",
        source: "repository:codegraph",
        title: "Repository relationships",
        excerpt: "fallback",
        score: 0,
        generation: "g2",
      },
      shapedQuery: "query",
      usedFallback: false,
    }));
    const broker = new RepositoryIntelligenceBroker({
      adapters: [primary, fallback],
      routes: { search: ["gitnexus", "codegraph"] },
      withRefreshLock: async (providerId, work) => {
        locks.push(providerId);
        return work();
      },
    });
    await broker.changed(["src/settlement.ts"]);
    locks.length = 0;

    const result = await broker.retrieve(request());

    expect(result.result?.providerId).toBe("codegraph");
    expect(locks).toEqual(["codegraph"]);
    expect(fallback.refresh).toHaveBeenCalled();
  });

  it("rejects routes whose adapter lacks the capability", () => {
    expect(() => new RepositoryIntelligenceBroker({
      adapters: [adapter("gitnexus", vi.fn())],
      routes: { impact: ["gitnexus"] },
    })).toThrow(/does not support.*impact/i);
  });

  it("rejects unknown providers in a route", () => {
    expect(() => new RepositoryIntelligenceBroker({
      adapters: [adapter("gitnexus", vi.fn())],
      routes: { search: ["missing-provider"] },
    })).toThrow(/Unknown repository intelligence provider/i);
  });

  it("soft-fails when every provider misses or throws and audits all attempts", async () => {
    const first = adapter("gitnexus", async () => ({
      shapedQuery: "SettlementWindow",
      usedFallback: false,
      skippedReason: "no-matches",
    }));
    const second = adapter("codegraph", async () => {
      throw new Error("CodeGraph exploded");
    });
    const broker = new RepositoryIntelligenceBroker({
      adapters: [first, second],
      routes: { search: ["gitnexus", "codegraph"] },
    });

    const result = await broker.retrieve(request());

    expect(result.result).toBeUndefined();
    expect(result.skippedReason).toMatch(/exploded|no-matches/i);
    expect(result.attempts.map((attempt) => [attempt.providerId, attempt.outcome])).toEqual([
      ["gitnexus", "miss"],
      ["codegraph", "failure"],
    ]);
  });

  it("records timeout outcomes distinctly from hard failures", async () => {
    const first = adapter("gitnexus", async () => {
      throw new Error("query timed out after 15s");
    });
    const second = adapter("codegraph", async () => ({
      shapedQuery: "SettlementWindow",
      usedFallback: false,
      skippedReason: "no-matches",
    }));
    const broker = new RepositoryIntelligenceBroker({
      adapters: [first, second],
      routes: { search: ["gitnexus", "codegraph"] },
    });

    const result = await broker.retrieve(request());

    expect(result.attempts[0]).toMatchObject({
      providerId: "gitnexus",
      outcome: "timeout",
    });
    expect(result.attempts[1]).toMatchObject({
      providerId: "codegraph",
      outcome: "miss",
    });
    expect(result.result).toBeUndefined();
  });

  it("returns capability-unrouted without attempting adapters", async () => {
    const only = adapter("gitnexus", vi.fn());
    const broker = new RepositoryIntelligenceBroker({
      adapters: [only],
      routes: { search: ["gitnexus"] },
    });

    const result = await broker.retrieve({
      capability: "impact",
      query: "SettlementWindow",
    });

    expect(result).toMatchObject({
      skippedReason: "capability-unrouted",
      attempts: [],
    });
    expect(only.retrieve).not.toHaveBeenCalled();
  });

  it("soft-skips unavailable primaries during prepare and leaves fallbacks lazy", async () => {
    const first = adapter("gitnexus", vi.fn(), {
      available: false,
      indexReady: false,
      detail: "command-unavailable",
    });
    const second = adapter("codegraph", vi.fn(), {
      available: true,
      indexReady: true,
    });
    const broker = new RepositoryIntelligenceBroker({
      adapters: [first, second],
      routes: { search: ["gitnexus", "codegraph"] },
    });

    await expect(broker.prepare()).resolves.toMatchObject({
      providers: [
        {
          providerId: "gitnexus",
          available: false,
          detail: "command-unavailable",
        },
        {
          providerId: "codegraph",
          available: true,
          indexReady: true,
        },
      ],
    });
    expect(first.prepare).toHaveBeenCalledOnce();
    expect(second.prepare).toHaveBeenCalledOnce();
  });

  it("still fails prepare when an available primary cannot build its index", async () => {
    const first = adapter("gitnexus", vi.fn(), {
      available: true,
      indexReady: false,
      detail: "analyze failed",
    });
    const broker = new RepositoryIntelligenceBroker({
      adapters: [first],
      routes: { search: ["gitnexus"] },
    });

    await expect(broker.prepare()).rejects.toThrow(
      "Repository intelligence provider gitnexus is not ready: analyze failed",
    );
  });

  it("marks unavailable adapters and continues the route", async () => {
    const first = adapter("gitnexus", vi.fn(), {
      available: false,
      indexReady: false,
      detail: "command-unavailable",
    });
    const second = adapter("codegraph", async () => ({
      artifact: {
        providerId: "codegraph",
        source: "repository:codegraph",
        title: "Repository relationships",
        excerpt: "hit",
        score: 0,
        generation: "g1",
      },
      shapedQuery: "query",
      usedFallback: false,
    }));
    const broker = new RepositoryIntelligenceBroker({
      adapters: [first, second],
      routes: { search: ["gitnexus", "codegraph"] },
    });

    const result = await broker.retrieve(request());

    expect(result.result?.providerId).toBe("codegraph");
    expect(result.attempts[0]).toMatchObject({
      providerId: "gitnexus",
      outcome: "unavailable",
      reason: "command-unavailable",
    });
  });

  it("invalidates cached hits when generation changes after refresh", async () => {
    let generation = "g1";
    const retrieve = vi.fn(async () => ({
      artifact: {
        providerId: "codegraph",
        source: "repository:codegraph",
        title: "Repository relationships",
        excerpt: `hit-${generation}`,
        score: 0,
        generation,
      },
      shapedQuery: "query",
      usedFallback: false,
    }));
    const provider = adapter("codegraph", retrieve);
    provider.readiness = vi.fn(async () => ({
      available: true,
      indexReady: true,
      generation,
    }));
    provider.refresh = vi.fn(async () => {
      generation = "g2";
      return {
        available: true,
        indexReady: true,
        generation,
        refreshed: true,
      };
    });
    const broker = new RepositoryIntelligenceBroker({
      adapters: [provider],
      routes: { search: ["codegraph"] },
    });

    const first = await broker.retrieve(request());
    const second = await broker.retrieve(request());
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(second.result?.excerpt).toBe(first.result?.excerpt);

    await broker.refresh();
    const third = await broker.retrieve(request());
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(third.result?.excerpt).toBe("hit-g2");
  });
});

function request(): RepositoryIntelligenceRequest {
  return { capability: "search", query: "SettlementWindow ledger" };
}

function adapter(
  id: string,
  retrieve: RepositoryIntelligenceAdapter["retrieve"],
  readinessOverrides?: {
    available?: boolean;
    indexReady?: boolean;
    detail?: string;
  },
): RepositoryIntelligenceAdapter {
  const generation = { value: "g1" };
  return {
    descriptor: {
      id,
      capabilities: ["search"],
      generatedArtifacts: [`.${id}/`],
    },
    readiness: vi.fn(async () => ({
      available: readinessOverrides?.available ?? true,
      indexReady: readinessOverrides?.indexReady ?? true,
      generation: generation.value,
      ...(readinessOverrides?.detail ? { detail: readinessOverrides.detail } : {}),
    })),
    prepare: vi.fn(async () => ({
      available: readinessOverrides?.available ?? true,
      indexReady: readinessOverrides?.indexReady ?? true,
      generation: generation.value,
      refreshed: false,
      ...(readinessOverrides?.detail ? { detail: readinessOverrides.detail } : {}),
    })),
    refresh: vi.fn(async () => {
      generation.value = "g2";
      return {
        available: readinessOverrides?.available ?? true,
        indexReady: readinessOverrides?.indexReady ?? true,
        generation: generation.value,
        refreshed: true,
        ...(readinessOverrides?.detail ? { detail: readinessOverrides.detail } : {}),
      };
    }),
    retrieve: vi.fn(retrieve),
    isRelevantPath: (filePath) => filePath.endsWith(".ts"),
  };
}

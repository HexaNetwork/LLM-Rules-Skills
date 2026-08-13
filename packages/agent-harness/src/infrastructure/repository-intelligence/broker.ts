import type {
  RepositoryCapability,
  RepositoryIntelligenceAdapter,
  RepositoryIntelligenceAttempt,
  RepositoryIntelligenceLifecycleAudit,
  RepositoryIntelligenceRequest,
  RepositoryIntelligenceResponse,
} from "./types.js";

type BrokerOptions = {
  adapters: RepositoryIntelligenceAdapter[];
  routes: Partial<Record<RepositoryCapability, string[]>>;
  withRefreshLock?: <T>(providerId: string, work: () => Promise<T>) => Promise<T>;
  cacheLimit?: number;
};

/** Ordered first-success routing plus lifecycle and provider-generation caching. */
export class RepositoryIntelligenceBroker {
  private readonly adapters = new Map<string, RepositoryIntelligenceAdapter>();
  private readonly routes: Partial<Record<RepositoryCapability, string[]>>;
  private readonly stale = new Set<string>();
  private readonly cache = new Map<string, RepositoryIntelligenceResponse>();
  private readonly cacheLimit: number;
  private readonly withRefreshLock: NonNullable<BrokerOptions["withRefreshLock"]>;

  constructor(options: BrokerOptions) {
    this.routes = options.routes;
    this.cacheLimit = options.cacheLimit ?? 64;
    this.withRefreshLock =
      options.withRefreshLock ?? (async (_providerId, work) => work());
    for (const adapter of options.adapters) {
      if (this.adapters.has(adapter.descriptor.id)) {
        throw new Error(`Duplicate repository intelligence provider: ${adapter.descriptor.id}`);
      }
      this.adapters.set(adapter.descriptor.id, adapter);
    }
    this.validateRoutes();
  }

  async retrieve(
    request: RepositoryIntelligenceRequest,
  ): Promise<RepositoryIntelligenceResponse> {
    const route = this.routes[request.capability] ?? [];
    if (route.length === 0) {
      return {
        shapedQuery: "",
        usedFallback: false,
        skippedReason: "capability-unrouted",
        attempts: [],
      };
    }

    const attempts: RepositoryIntelligenceAttempt[] = [];
    let lastShapedQuery = "";
    let usedFallback = false;
    let lastReason = "all-providers-missed";
    for (const [routeIndex, providerId] of route.entries()) {
      const adapter = this.adapters.get(providerId)!;
      const started = Date.now();
      let refreshed = false;
      try {
        let readiness = await adapter.readiness();
        if (this.stale.has(providerId) || !readiness.indexReady) {
          // Primary routes are prepared eagerly by prepare(); fallback routes refresh
          // only when traversal reaches them.
          const lifecycle = await this.withRefreshLock(providerId, () => adapter.refresh());
          refreshed = lifecycle.refreshed;
          readiness = lifecycle;
          if (lifecycle.indexReady) this.stale.delete(providerId);
        }
        if (!readiness.available || !readiness.indexReady) {
          lastReason = readiness.detail ?? (readiness.available ? "index-missing" : "unavailable");
          attempts.push({
            providerId,
            capability: request.capability,
            outcome: "unavailable",
            generation: readiness.generation,
            refreshed,
            reason: lastReason,
            durationMs: Date.now() - started,
          });
          continue;
        }

        const cacheKey = this.cacheKey(providerId, readiness.generation, request);
        const cached = this.cache.get(cacheKey);
        if (cached) {
          const attempt: RepositoryIntelligenceAttempt = {
            providerId,
            capability: request.capability,
            outcome: cached.result ? "success" : "miss",
            generation: readiness.generation,
            refreshed,
            reason: cached.skippedReason,
            durationMs: Date.now() - started,
          };
          attempts.push(attempt);
          if (cached.result) {
            return cloneResponse({ ...cached, attempts });
          }
          lastShapedQuery = cached.shapedQuery;
          usedFallback ||= cached.usedFallback;
          lastReason = cached.skippedReason ?? "no-matches";
          continue;
        }

        const retrieved = await adapter.retrieve(request);
        lastShapedQuery = retrieved.shapedQuery;
        usedFallback ||= retrieved.usedFallback;
        lastReason = retrieved.skippedReason ?? "no-matches";
        const attempt: RepositoryIntelligenceAttempt = {
          providerId,
          capability: request.capability,
          outcome: retrieved.artifact ? "success" : "miss",
          generation: readiness.generation,
          refreshed,
          reason: retrieved.skippedReason,
          durationMs: Date.now() - started,
        };
        attempts.push(attempt);
        const response: RepositoryIntelligenceResponse = {
          result: retrieved.artifact,
          shapedQuery: retrieved.shapedQuery,
          usedFallback: retrieved.usedFallback,
          skippedReason: retrieved.skippedReason,
          attempts: [attempt],
        };
        this.remember(cacheKey, response);
        if (retrieved.artifact) {
          return cloneResponse({ ...response, attempts });
        }
        // routeIndex is intentionally observed: it documents that misses advance,
        // while a final miss is returned after the loop.
        void routeIndex;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        lastReason = reason;
        attempts.push({
          providerId,
          capability: request.capability,
          outcome: /timed out|timeout/i.test(reason) ? "timeout" : "failure",
          refreshed,
          reason,
          durationMs: Date.now() - started,
        });
      }
    }
    return {
      shapedQuery: lastShapedQuery,
      usedFallback,
      skippedReason: lastReason,
      attempts,
    };
  }

  /** Provider readiness snapshot for operator surfaces (does not refresh indexes). */
  async status(): Promise<{
    providers: Array<{
      providerId: string;
      available: boolean;
      indexReady: boolean;
      generation: string;
      detail?: string;
    }>;
    routes: Partial<Record<RepositoryCapability, string[]>>;
  }> {
    const providers = [];
    for (const adapter of this.adapters.values()) {
      providers.push({ providerId: adapter.descriptor.id, ...(await adapter.readiness()) });
    }
    return {
      providers,
      routes: Object.fromEntries(
        Object.entries(this.routes).map(([capability, route]) => [capability, [...(route ?? [])]]),
      ),
    };
  }

  /** Prepare the first provider in every route; fallback indexes remain lazy. */
  async prepare(): Promise<RepositoryIntelligenceLifecycleAudit> {
    const primary = new Set(
      Object.values(this.routes).flatMap((route) => route?.slice(0, 1) ?? []),
    );
    const providers = [];
    for (const providerId of primary) {
      const adapter = this.adapters.get(providerId);
      if (!adapter) continue;
      const result = await adapter.prepare();
      providers.push({ providerId, ...result });
      this.stale.delete(providerId);
      if (!result.available || !result.indexReady) {
        const detail = result.detail?.trim();
        throw new Error(
          detail
            ? `Repository intelligence provider ${providerId} is not ready: ${detail}`
            : `Repository intelligence provider ${providerId} is not ready`,
        );
      }
    }
    return { providers };
  }

  async refresh(): Promise<RepositoryIntelligenceLifecycleAudit> {
    const primary = new Set(
      Object.values(this.routes).flatMap((route) => route?.slice(0, 1) ?? []),
    );
    const providers = [];
    for (const providerId of primary) {
      const adapter = this.adapters.get(providerId);
      if (!adapter) continue;
      const result = await this.withRefreshLock(providerId, () => adapter.refresh());
      providers.push({ providerId, ...result });
      if (result.indexReady) this.stale.delete(providerId);
    }
    this.cache.clear();
    return { providers };
  }

  /** Relevant source changes invalidate all capable indexes; only primaries refresh now. */
  async changed(paths: string[]): Promise<RepositoryIntelligenceLifecycleAudit> {
    let relevant = false;
    for (const adapter of this.adapters.values()) {
      if (paths.some((changedPath) => adapter.isRelevantPath(changedPath))) {
        this.stale.add(adapter.descriptor.id);
        relevant = true;
      }
    }
    if (!relevant) return { providers: [] };
    this.cache.clear();
    return this.refresh();
  }

  private validateRoutes(): void {
    for (const [capability, route] of Object.entries(this.routes)) {
      for (const providerId of route ?? []) {
        const adapter = this.adapters.get(providerId);
        if (!adapter) {
          throw new Error(`Unknown repository intelligence provider ${providerId} in ${capability} route`);
        }
        if (!adapter.descriptor.capabilities.includes(capability as RepositoryCapability)) {
          throw new Error(`Provider ${providerId} does not support repository capability ${capability}`);
        }
      }
    }
  }

  private cacheKey(
    providerId: string,
    generation: string,
    request: RepositoryIntelligenceRequest,
  ): string {
    return JSON.stringify([
      providerId,
      generation,
      request.capability,
      request.query,
      request.fallbackQuery,
      request.pathHints,
      request.changedPaths,
      request.maxCharacters,
    ]);
  }

  private remember(key: string, value: RepositoryIntelligenceResponse): void {
    if (!this.cache.has(key) && this.cache.size >= this.cacheLimit) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, cloneResponse(value));
  }
}

function cloneResponse(value: RepositoryIntelligenceResponse): RepositoryIntelligenceResponse {
  return {
    ...value,
    result: value.result
      ? { ...value.result, metadata: value.result.metadata ? { ...value.result.metadata } : undefined }
      : undefined,
    attempts: value.attempts.map((attempt) => ({ ...attempt })),
  };
}

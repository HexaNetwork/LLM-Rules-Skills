export const REPOSITORY_CAPABILITIES = [
  "search",
  "symbol-context",
  "impact",
  "trace",
  "change-impact",
] as const;

export type RepositoryCapability = (typeof REPOSITORY_CAPABILITIES)[number];
export type RepositoryProviderId = string;

export type ExecutableResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type ExecutableRunOptions = {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxBuffer?: number;
};

/** Argument-array only: adapters never construct shell command strings. */
export type ExecutableRunner = (
  executable: string,
  args: readonly string[],
  options: ExecutableRunOptions,
) => Promise<ExecutableResult>;

export type RepositoryIntelligenceRequest = {
  capability: RepositoryCapability;
  query: string;
  fallbackQuery?: string;
  pathHints?: string[];
  changedPaths?: string[];
  maxCharacters?: number;
};

export type RepositoryIntelligenceArtifact = {
  providerId: RepositoryProviderId;
  source: string;
  title: string;
  excerpt: string;
  score: number;
  generation: string;
  metadata?: Record<string, string | number | boolean>;
};

export type AdapterRetrieval = {
  artifact?: RepositoryIntelligenceArtifact;
  shapedQuery: string;
  usedFallback: boolean;
  skippedReason?: string;
};

export type AdapterReadiness = {
  available: boolean;
  indexReady: boolean;
  generation: string;
  detail?: string;
};

export type AdapterLifecycleResult = AdapterReadiness & {
  refreshed: boolean;
};

export type RepositoryIntelligenceAdapter = {
  readonly descriptor: {
    id: RepositoryProviderId;
    capabilities: readonly RepositoryCapability[];
    generatedArtifacts: readonly string[];
  };
  readiness(): Promise<AdapterReadiness>;
  prepare(): Promise<AdapterLifecycleResult>;
  refresh(): Promise<AdapterLifecycleResult>;
  retrieve(request: RepositoryIntelligenceRequest): Promise<AdapterRetrieval>;
  isRelevantPath(path: string): boolean;
};

export type RepositoryIntelligenceAttempt = {
  providerId: RepositoryProviderId;
  capability: RepositoryCapability;
  outcome: "success" | "miss" | "unavailable" | "failure" | "timeout";
  generation?: string;
  refreshed?: boolean;
  reason?: string;
  durationMs: number;
};

export type RepositoryIntelligenceResponse = {
  result?: RepositoryIntelligenceArtifact;
  shapedQuery: string;
  usedFallback: boolean;
  skippedReason?: string;
  attempts: RepositoryIntelligenceAttempt[];
};

export type RepositoryIntelligenceLifecycleAudit = {
  providers: Array<{
    providerId: RepositoryProviderId;
    available: boolean;
    indexReady: boolean;
    generation: string;
    refreshed: boolean;
    detail?: string;
  }>;
};

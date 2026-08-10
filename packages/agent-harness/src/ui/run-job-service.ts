export type UiJob = {
  runId: string;
  action: string;
  status: "queued" | "running" | "failed";
  detail?: string;
  error?: string;
  queuedAt: string;
  startedAt?: string;
};

/** How long a failed job stays visible so the dashboard can toast the error. */
const FAILED_JOB_TTL_MS = 30_000;

export class RunJobConflictError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "RunJobConflictError";
  }
}

/**
 * Process-local mutation queue: one job per run, serialized across runs.
 * Routes enqueue work here and never mutate a run inline.
 */
export class RunJobService {
  private readonly jobs = new Map<string, UiJob>();
  private queue = Promise.resolve();

  get(runId: string): UiJob | undefined {
    return this.jobs.get(runId);
  }

  values(): UiJob[] {
    return [...this.jobs.values()];
  }

  setDetail(runId: string, detail: string): void {
    const current = this.jobs.get(runId);
    if (current) this.jobs.set(runId, { ...current, detail });
  }

  enqueue(runId: string, action: string, operation: () => Promise<unknown>): void {
    const existing = this.jobs.get(runId);
    if (existing && existing.status !== "failed") {
      throw new RunJobConflictError(`Run ${runId} already has queued work`);
    }
    const job: UiJob = {
      runId,
      action,
      status: "queued",
      queuedAt: new Date().toISOString(),
    };
    this.jobs.set(runId, job);
    const scheduled = this.queue
      .catch(() => undefined)
      .then(async () => {
        this.jobs.set(runId, {
          ...job,
          status: "running",
          startedAt: new Date().toISOString(),
        });
        try {
          await operation();
          this.jobs.delete(runId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.jobs.set(runId, {
            ...job,
            status: "failed",
            startedAt: this.jobs.get(runId)?.startedAt ?? new Date().toISOString(),
            error: message,
          });
          setTimeout(() => {
            const current = this.jobs.get(runId);
            if (current?.status === "failed") this.jobs.delete(runId);
          }, FAILED_JOB_TTL_MS);
        }
      });
    this.queue = scheduled.catch(() => undefined);
  }
}

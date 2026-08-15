/**
 * Process-wide registry of in-flight advance AbortControllers.
 * Worker processes may construct a fresh runtime per request, but cancel must
 * still abort an in-flight advance in the same Node process.
 */
export class RunCancellationRegistry {
  private readonly active = new Map<string, AbortController>();

  register(runId: string): AbortController {
    const controller = new AbortController();
    this.active.set(runId, controller);
    return controller;
  }

  signalFor(runId: string): AbortSignal | undefined {
    return this.active.get(runId)?.signal;
  }

  abort(runId: string): boolean {
    const controller = this.active.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  release(runId: string): void {
    this.active.delete(runId);
  }

  has(runId: string): boolean {
    return this.active.has(runId);
  }
}

/** Singleton used by production engines and cancel paths across instances. */
export const runCancellationRegistry = new RunCancellationRegistry();

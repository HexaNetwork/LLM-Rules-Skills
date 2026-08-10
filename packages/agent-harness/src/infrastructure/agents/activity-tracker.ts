import type { AgentRole } from "../../domain.js";
import type { RunStore } from "../../store.js";
import type { AgentStepEvent } from "./types.js";

/** Mutable so tests can exercise the cap without writing thousands of lines. */
export const stepPersistenceLimits = {
  maxLines: 2_000,
  maxBytes: 256 * 1024,
};
const ACTIVITY_WRITE_MIN_MS = 1_000;

type SessionActivity = {
  sessionId: string;
  role: AgentRole;
  model: string;
  startedAt: string;
  lastStepAt?: string;
  lastStepSummary?: string;
  stepCount: number;
  truncated?: boolean;
};

export function createSessionActivityTracker(
  store: RunStore,
  runId: string,
  base: { sessionId: string; role: AgentRole; model: string; startedAt: string },
) {
  const stepsPath = `sessions/${base.sessionId}.steps.jsonl`;
  let stepCount = 0;
  let stepsBytes = 0;
  let truncated = false;
  let lastStepAt: string | undefined;
  let lastStepSummary: string | undefined;
  let lastWriteAt = 0;
  let chain = Promise.resolve();
  let pendingWrite = false;
  let trailingTimer: NodeJS.Timeout | undefined;

  function snapshot(): SessionActivity {
    return {
      sessionId: base.sessionId,
      role: base.role,
      model: base.model,
      startedAt: base.startedAt,
      ...(lastStepAt ? { lastStepAt } : {}),
      ...(lastStepSummary ? { lastStepSummary } : {}),
      stepCount,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  async function writeActivity(): Promise<void> {
    lastWriteAt = Date.now();
    pendingWrite = false;
    await store.writeJson(runId, "activity.json", snapshot());
  }

  function scheduleActivityWrite(force = false): void {
    pendingWrite = true;
    if (force) {
      if (trailingTimer) {
        clearTimeout(trailingTimer);
        trailingTimer = undefined;
      }
      chain = chain.then(() => writeActivity()).catch(() => undefined);
      return;
    }
    if (trailingTimer) return;
    const waitMs = Math.max(0, ACTIVITY_WRITE_MIN_MS - (Date.now() - lastWriteAt));
    trailingTimer = setTimeout(() => {
      trailingTimer = undefined;
      chain = chain.then(() => writeActivity()).catch(() => undefined);
    }, waitMs);
  }

  return {
    writeNow() {
      chain = chain.then(() => writeActivity()).catch(() => undefined);
      return chain;
    },
    recordStep(step: AgentStepEvent) {
      chain = chain
        .then(async () => {
          const at = new Date().toISOString();
          const line = {
            type: step.type,
            ...(step.toolName ? { toolName: step.toolName } : {}),
            ...(step.summary ? { summary: step.summary } : {}),
            at,
          };
          const encoded = `${JSON.stringify(line)}\n`;
          const wasEmpty = stepCount === 0 && !truncated;
          if (!truncated) {
            if (
              stepCount >= stepPersistenceLimits.maxLines ||
              stepsBytes + Buffer.byteLength(encoded, "utf8") > stepPersistenceLimits.maxBytes
            ) {
              truncated = true;
              const marker = { type: "truncated", at };
              await store.appendJsonl(runId, stepsPath, marker);
              stepsBytes += Buffer.byteLength(`${JSON.stringify(marker)}\n`, "utf8");
            } else {
              await store.appendJsonl(runId, stepsPath, line);
              stepCount += 1;
              stepsBytes += Buffer.byteLength(encoded, "utf8");
            }
          }
          lastStepAt = at;
          lastStepSummary = step.summary ?? step.toolName ?? step.type;
          // First step bypasses the throttle so the header lights up immediately.
          scheduleActivityWrite(wasEmpty);
        })
        .catch(() => undefined);
    },
    async flush() {
      if (trailingTimer) {
        clearTimeout(trailingTimer);
        trailingTimer = undefined;
      }
      await chain;
      if (pendingWrite || lastWriteAt === 0) await writeActivity();
    },
    async clear() {
      if (trailingTimer) {
        clearTimeout(trailingTimer);
        trailingTimer = undefined;
      }
      await chain;
      await store.remove(runId, "activity.json");
    },
  };
}

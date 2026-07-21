/** Structured progress lines for AFK runs (stdout so redirects capture them). */

export type HarnessLogDetail = Record<string, unknown>;

function formatDetail(detail?: HarnessLogDetail): string {
  if (!detail || Object.keys(detail).length === 0) return "";
  const parts = Object.entries(detail).map(([key, value]) => {
    if (value === undefined || value === null) return `${key}=`;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return `${key}=${value}`;
    }
    return `${key}=${JSON.stringify(value)}`;
  });
  return ` ${parts.join(" ")}`;
}

/**
 * Emit a single progress line.
 * Example: `[agent-harness 2026-07-21T06:00:00.000Z] worker.start taskId=foo model=composer-2.5`
 */
export function harnessLog(
  phase: string,
  message: string,
  detail?: HarnessLogDetail,
): void {
  const at = new Date().toISOString();
  const line = `[agent-harness ${at}] ${phase} ${message}${formatDetail(detail)}`;
  console.log(line);
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m${rem}s`;
}

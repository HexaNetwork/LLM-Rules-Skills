export function formatCursorAgentFailure(
  role: string,
  result: { exitCode: number; stdout: string; stderr: string },
): string {
  const raw = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  return `Cursor agent failed (${role}): ${sanitizeNodeProcessOutput(raw)}`;
}

/** Strip Node's minified source dumps / warnings so the real error stays readable. */
export function sanitizeNodeProcessOutput(raw: string, maxLen = 2000): string {
  const filtered = raw
    .split(/\r?\n/)
    .filter((line) => {
      if (line.length > 500) return false;
      if (/ExperimentalWarning/.test(line)) return false;
      if (/Use `node --trace-warnings/.test(line)) return false;
      if (/^file:\/\/\S+:\d+$/.test(line)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (filtered.length <= maxLen) return filtered || raw.slice(0, maxLen);
  return filtered.slice(filtered.length - maxLen);
}

export function formatInvokeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [`${error.name}: ${error.message}`];
  const meta = error as Error & {
    cause?: unknown;
    endpoint?: string;
    operation?: string;
    isRetryable?: boolean;
  };
  if (meta.operation) parts.push(`operation: ${meta.operation}`);
  if (meta.endpoint) parts.push(`endpoint: ${meta.endpoint}`);
  if (meta.isRetryable != null) parts.push(`retryable: ${meta.isRetryable}`);
  let cause: unknown = meta.cause;
  for (let depth = 0; cause && depth < 5; depth += 1) {
    if (cause instanceof Error) {
      const nested = cause as Error & { cause?: unknown; code?: string; hostname?: string };
      const detail = [nested.name, nested.message, nested.code, nested.hostname].filter(Boolean).join(": ");
      parts.push(`caused by: ${detail}`);
      cause = nested.cause;
      continue;
    }
    parts.push(`caused by: ${String(cause)}`);
    break;
  }
  return parts.join("\n");
}

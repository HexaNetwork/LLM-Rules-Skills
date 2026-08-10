/**
 * Event-based polling helper for integration tests.
 * Do not use fixed sleeps as the success condition — wait until `probe` is true.
 */
export async function waitUntil(
  probe: () => boolean | Promise<boolean>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    message?: string;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await probe()) return;
    if (Date.now() >= deadline) {
      throw new Error(options.message ?? `waitUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

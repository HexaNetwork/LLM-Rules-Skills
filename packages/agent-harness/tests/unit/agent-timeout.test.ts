import { describe, expect, it, vi } from "vitest";
import { renderDashboardPage } from "../../src/ui/page.js";
import { withAgentTimeout } from "../../src/worker/invoke.js";

describe("agent invocation timeout", () => {
  it("rejects a stalled operation and requests provider cancellation", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(async () => undefined);
      const stalled = new Promise<never>(() => undefined);
      const result = withAgentTimeout(stalled, 5_000, cancel, "implementer");
      const rejection = expect(result).rejects.toThrow(
        "Agent timed out (implementer) after 5000ms",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the deadline after a successful operation", async () => {
    await expect(withAgentTimeout(Promise.resolve("done"), 5_000, undefined, "planner"))
      .resolves.toBe("done");
  });
});

describe("dashboard timeout settings", () => {
  it("exposes the global and project timeout editor", () => {
    const html = renderDashboardPage();
    expect(html).toContain('id="settings-toggle"');
    expect(html).toContain("Agent deadline");
    expect(html).toContain("/api/settings/agent-timeout");
    expect(html).toContain('id="agent-timeout-minutes"');
  });
});

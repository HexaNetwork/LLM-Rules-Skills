import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDurationMs, harnessLog } from "../../src/util/log.js";

describe("harnessLog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("formats durations", () => {
    expect(formatDurationMs(400)).toBe("400ms");
    expect(formatDurationMs(12_000)).toBe("12s");
    expect(formatDurationMs(125_000)).toBe("2m5s");
  });

  it("prints a structured progress line", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    harnessLog("worker.start", "launching", { taskId: "t1", model: "composer-2.5" });
    expect(spy).toHaveBeenCalledOnce();
    const line = String(spy.mock.calls[0]?.[0]);
    expect(line).toMatch(/^\[agent-harness \d{4}-\d{2}-\d{2}T/);
    expect(line).toContain("worker.start launching");
    expect(line).toContain("taskId=t1");
    expect(line).toContain("model=composer-2.5");
  });
});

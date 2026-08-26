import { describe, expect, it, vi, afterEach } from "vitest";
import { createCommandService } from "../../src/plugins/commands.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("commands.verify sandbox argv", () => {
  it("uses POSIX sh -c for docker sandbox even when the host is win32", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    const appendEvent = vi.fn().mockResolvedValue(undefined);
    const commands = createCommandService({
      sandbox: { mode: "docker", exec },
      store: { appendEvent },
    } as never);

    await commands.verify("run-win32-docker", "npm test");

    expect(exec).toHaveBeenCalledWith("run-win32-docker", {
      command: ["sh", "-c", "npm test"],
    });
    expect(appendEvent).toHaveBeenCalledTimes(2);
    expect(appendEvent.mock.calls[0]?.[1]).toMatchObject({
      kind: "verification",
      status: "started",
      command: "npm test",
    });
    expect(appendEvent.mock.calls[1]?.[1]).toMatchObject({
      kind: "verification",
      status: "passed",
      command: "npm test",
      exitCode: 0,
      classification: "passed",
    });
  });

  it("keeps the host Windows shell for local sandbox on win32", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    const appendEvent = vi.fn().mockResolvedValue(undefined);
    const commands = createCommandService({
      sandbox: { mode: "none", exec },
      store: { appendEvent },
    } as never);

    await commands.verify("run-win32-host", "npm test");

    expect(exec).toHaveBeenCalledWith("run-win32-host", {
      command: ["cmd", "/c", "npm test"],
    });
  });
});

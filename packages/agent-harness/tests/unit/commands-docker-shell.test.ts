import { describe, expect, it, vi, afterEach } from "vitest";
import { createCommandService } from "../../src/plugins/commands.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("commands.verify sandbox argv", () => {
  it("uses POSIX sh -c for docker sandbox even when the host is win32", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    const commands = createCommandService({
      sandbox: { mode: "docker", exec },
    } as never);

    await commands.verify("run-win32-docker", "npm test");

    expect(exec).toHaveBeenCalledWith("run-win32-docker", {
      command: ["sh", "-c", "npm test"],
    });
  });

  it("keeps the host Windows shell for local sandbox on win32", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    const commands = createCommandService({
      sandbox: { mode: "none", exec },
    } as never);

    await commands.verify("run-win32-host", "npm test");

    expect(exec).toHaveBeenCalledWith("run-win32-host", {
      command: ["cmd", "/c", "npm test"],
    });
  });
});

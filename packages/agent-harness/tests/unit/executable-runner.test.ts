import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  quoteCmdArgument,
  resolveExecutableInvocation,
  runExecutable,
} from "../../src/infrastructure/repository-intelligence/executable-runner.js";

describe("executable-runner Windows resolution", () => {
  it("quotes cmd.exe arguments with embedded spaces and quotes", () => {
    expect(quoteCmdArgument("plain")).toBe("plain");
    expect(quoteCmdArgument("")).toBe('""');
    expect(quoteCmdArgument("C:\\Program Files\\app")).toBe('"C:\\Program Files\\app"');
    expect(quoteCmdArgument('say "hi"')).toBe('"say ""hi"""');
  });

  it("prefers .cmd over extensionless npm shims and invokes via ComSpec", () => {
    const npmBin = path.join("C:", "Users", "ops", "AppData", "Roaming", "npm");
    const existing = new Set([
      path.join(npmBin, "gitnexus"),
      path.join(npmBin, "gitnexus.cmd"),
    ]);
    const invocation = resolveExecutableInvocation(
      "gitnexus",
      ["--version"],
      {
        platform: "win32",
        env: {
          PATH: npmBin,
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
        existsSync: (candidate) => existing.has(candidate),
      },
    );

    expect(invocation).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        `${path.join(npmBin, "gitnexus.cmd")} --version`,
      ],
      windowsVerbatimArguments: true,
    });
  });

  it("leaves non-Windows invocations unchanged", () => {
    expect(
      resolveExecutableInvocation("gitnexus", ["analyze", "/repo"], {
        platform: "linux",
      }),
    ).toEqual({
      file: "gitnexus",
      args: ["analyze", "/repo"],
    });
  });
});

describe("runExecutable integration", () => {
  it("can invoke gitnexus --version when the CLI is installed", async () => {
    const previousPath = process.env.PATH ?? process.env.Path ?? "";
    const npmBin =
      process.platform === "win32" && process.env.APPDATA
        ? path.join(process.env.APPDATA, "npm")
        : undefined;
    if (npmBin && !previousPath.toLowerCase().includes(npmBin.toLowerCase())) {
      process.env.PATH = `${npmBin}${path.delimiter}${previousPath}`;
    }
    try {
      const result = await runExecutable("gitnexus", ["--version"], {
        cwd: process.cwd(),
        timeoutMs: 15_000,
      });
      if (result.exitCode !== 0) {
        // Optional toolchain: skip rather than fail developer machines without it.
        expect(result.stderr || result.stdout).toMatch(/ENOENT|not recognized|not found|spawn/i);
        return;
      }
      expect(result.stdout.trim()).toMatch(/\d+\.\d+/);
      expect(result.timedOut).toBe(false);
    } finally {
      process.env.PATH = previousPath;
    }
  }, 20_000);
});

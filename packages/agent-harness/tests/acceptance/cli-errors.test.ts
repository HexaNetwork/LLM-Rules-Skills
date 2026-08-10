import path from "node:path";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";
import { runCli } from "./helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distCli = path.join(packageRoot, "dist", "cli.js");

describe("CLI acceptance errors and package entry", () => {
  let fixture: ProjectFixture | undefined;
  let previousCwd: string | undefined;

  afterEach(async () => {
    if (previousCwd) process.chdir(previousCwd);
    previousCwd = undefined;
    await fixture?.cleanup();
    fixture = undefined;
  });

  it("rejects invalid arguments with non-zero, actionable output", async () => {
    const missingIdea = await runCli(["start", "--tdd", "off"]);
    expect(missingIdea.code).not.toBe(0);
    const message = `${missingIdea.stderr.join("\n")}\n${String((missingIdea.error as Error)?.message ?? "")}`;
    expect(message).toMatch(/idea|required/i);

    fixture = await createProjectFixture();
    const { writeAcceptanceConfig } = await import("./helpers.js");
    const configPath = await writeAcceptanceConfig(fixture);
    const badTdd = await runCli([
      "start",
      "--idea",
      "x",
      "--tdd",
      "maybe",
      "--config",
      configPath,
    ]);
    expect(badTdd.code).not.toBe(0);
    expect(
      `${badTdd.stderr.join("\n")}\n${badTdd.stdout.join("\n")}\n${String((badTdd.error as Error)?.message ?? "")}`,
    ).toMatch(/tdd must be 'on' or 'off'/i);
  });

  it("compiled dist/cli.js --help validates the bin entry and ESM imports", async () => {
    await expectDistBuilt();
    const result = await spawnNode(distCli, ["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/agent-harness|Durable idea-to-feature/i);
    expect(result.stdout).toMatch(/start|status|answer|continue/i);
    expect(result.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/i);
  });

  it("compiled dist/cli.js init writes config in a clean fixture", async () => {
    await expectDistBuilt();
    fixture = await createProjectFixture();
    previousCwd = process.cwd();
    process.chdir(fixture.root);

    const result = await spawnNode(distCli, ["init"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Wrote .*agent-harness\.config\.yaml/);
    await access(path.join(fixture.root, "agent-harness.config.yaml"));
    await access(path.join(fixture.root, ".agent-harness"));
  });
});

async function expectDistBuilt(): Promise<void> {
  try {
    await access(distCli);
  } catch {
    throw new Error(
      `Missing ${distCli}. Run \`npm run build -w @hexanetwork/agent-harness\` before acceptance tests that exercise the compiled bin.`,
    );
  }
}

function spawnNode(
  script: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: "0" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

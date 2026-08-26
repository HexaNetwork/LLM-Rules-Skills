import type { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { writeRunDockerfile } from "../../src/domain/image-repair.js";
import type { Run } from "../../src/domain/types.js";
import { resolveVerificationRuntime } from "../../src/domain/verification-runtime.js";
import { createTempDir } from "../helpers.js";

function fakeRun(runId: string): Run {
  return {
    identity: { runId },
    state: { runId, artifacts: {}, fog: [], tasks: [] },
    settings: {},
  } as unknown as Run;
}

describe("resolveVerificationRuntime", () => {
  it("returns host-local runtime without dockerfile when mode is none", async () => {
    const ctx = {
      sandbox: { mode: "none", image: "unused-on-host" },
      store: { home: "/tmp/harness" },
    } as unknown as Context;

    await expect(resolveVerificationRuntime(ctx, fakeRun("r-none"))).resolves.toEqual({
      mode: "none",
      image: "unused-on-host",
    });
  });

  it("uses the main Dockerfile and sandbox image when docker has no override", async () => {
    const harnessHome = await createTempDir("verification-runtime-");
    const ctx = {
      sandbox: { mode: "docker", image: "node:22-bookworm-slim" },
      store: { home: harnessHome },
    } as unknown as Context;

    const runtime = await resolveVerificationRuntime(ctx, fakeRun("r-main"));
    expect(runtime.mode).toBe("docker");
    expect(runtime.image).toBe("node:22-bookworm-slim");
    expect(runtime.dockerfile).toContain("FROM ");
    expect(runtime.dockerfile).toContain("WORKDIR /workspace");
  });

  it("prefers the run Dockerfile override and run image tag", async () => {
    const harnessHome = await createTempDir("verification-runtime-override-");
    const runId = "r-override";
    const override = [
      "FROM node:22-bookworm-slim",
      "RUN echo override",
      "USER 10001:10001",
      "WORKDIR /workspace",
      'CMD ["sleep", "infinity"]',
      "",
    ].join("\n");
    await writeRunDockerfile(harnessHome, runId, override);

    const ctx = {
      sandbox: { mode: "docker", image: "node:22-bookworm-slim" },
      store: { home: harnessHome },
    } as unknown as Context;

    await expect(resolveVerificationRuntime(ctx, fakeRun(runId))).resolves.toEqual({
      mode: "docker",
      image: `agent-harness-worker-run-${runId}`,
      dockerfile: override,
    });
  });
});

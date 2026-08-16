import { describe, expect, it } from "vitest";
import { buildRunSpec, validateMounts } from "../../src/domain/mount-policy.js";

const policy = {
  controlRoot: "D:/repos/app",
  harnessHome: "D:/data/agent-harness",
  siblingRunRoots: ["D:/data/agent-harness/runs/other"],
};

describe("mount policy", () => {
  it("accepts a worktree bind and CURSOR_API_KEY in env", () => {
    const spec = buildRunSpec({
      runId: "run-1",
      image: "node:22-bookworm-slim",
      worktreeHost: "D:/data/agent-harness/projects/app/worktrees/run-1",
      cursorApiKey: "key",
    });
    expect(spec.env.CURSOR_API_KEY).toBe("key");
    expect(() => validateMounts(spec, policy)).not.toThrow();
  });

  it("rejects host secrets, control checkout, harness home, and the docker socket", () => {
    const base = buildRunSpec({
      runId: "run-1",
      image: "node:22-bookworm-slim",
      worktreeHost: "D:/data/agent-harness/projects/app/worktrees/run-1",
    });
    expect(() =>
      validateMounts({ ...base, env: { ...base.env, GITHUB_TOKEN: "ghs_xxx" } }, policy),
    ).toThrow(/GITHUB_TOKEN/);
    expect(() =>
      validateMounts(
        { ...base, mounts: [...base.mounts, { host: "D:/repos/app", container: "/control" }] },
        policy,
      ),
    ).toThrow(/Control checkout/);
    expect(() =>
      validateMounts(
        { ...base, mounts: [...base.mounts, { host: "D:/data/agent-harness", container: "/home" }] },
        policy,
      ),
    ).toThrow(/Harness home/);
    expect(() => validateMounts({ ...base, bindsSocket: true }, policy)).toThrow(/socket/);
  });
});

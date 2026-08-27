import { describe, expect, it } from "vitest";
import { gradleBuildVolumeName, gradleCacheVolumeName } from "../../src/domain/gradle-sandbox.js";
import { buildRunSpec, validateMounts } from "../../src/domain/mount-policy.js";

const policy = {
  controlRoot: "D:/repos/app",
  harnessHome: "D:/data/agent-harness",
  siblingRunRoots: ["D:/data/agent-harness/runs/other"],
  projectKey: "app-abc12345",
};

describe("mount policy", () => {
  it("accepts a worktree bind, Gradle named volumes, and CURSOR_API_KEY in env", () => {
    const spec = buildRunSpec({
      runId: "run-1",
      image: "node:22-bookworm-slim",
      worktreeHost: "D:/data/agent-harness/projects/app/worktrees/run-1",
      cursorApiKey: "key",
      projectKey: "app-abc12345",
    });
    expect(spec.env.CURSOR_API_KEY).toBe("key");
    expect(spec.env.GRADLE_USER_HOME).toBe("/gradle-cache");
    expect(spec.env["ORG_GRADLE_PROJECT_org.gradle.vfs.watch"]).toBe("false");
    expect(spec.mounts).toEqual([
      { host: "D:/data/agent-harness/projects/app/worktrees/run-1", container: "/workspace", kind: "bind" },
      { host: gradleCacheVolumeName("app-abc12345"), container: "/gradle-cache", kind: "volume" },
      { host: gradleBuildVolumeName("app-abc12345"), container: "/gradle-build", kind: "volume" },
    ]);
    expect(() => validateMounts(spec, policy)).not.toThrow();
  });

  it("rejects Windows bind mounts for Gradle cache and build dirs", () => {
    const base = buildRunSpec({
      runId: "run-1",
      image: "node:22-bookworm-slim",
      worktreeHost: "D:/data/agent-harness/projects/app/worktrees/run-1",
    });
    expect(() =>
      validateMounts(
        {
          ...base,
          mounts: [
            ...base.mounts,
            { host: "D:/data/agent-harness/projects/app/gradle-cache", container: "/gradle-cache" },
          ],
        },
        policy,
      ),
    ).toThrow(/named volume/);
    expect(() =>
      validateMounts(
        {
          ...base,
          mounts: [
            ...base.mounts,
            { host: "D:/data/agent-harness/projects/app/gradle-build", container: "/gradle-build" },
          ],
        },
        policy,
      ),
    ).toThrow(/named volume/);
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

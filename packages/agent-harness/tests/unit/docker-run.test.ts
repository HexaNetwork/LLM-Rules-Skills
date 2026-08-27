import { describe, expect, it } from "vitest";
import { buildDockerRunArgs, WORKER_DNS_SERVERS } from "../../src/domain/docker-run.js";
import { gradleBuildVolumeName, gradleCacheVolumeName } from "../../src/domain/gradle-sandbox.js";
import { buildRunSpec } from "../../src/domain/mount-policy.js";

describe("buildDockerRunArgs", () => {
  it("pins public DNS resolvers and mounts Gradle named volumes", () => {
    const spec = buildRunSpec({
      runId: "11111111-2222-4333-8444-555555555555",
      image: "agent-harness-worker:local",
      worktreeHost: "D:/data/worktree",
      cursorApiKey: "key",
      projectKey: "app-deadbeef",
    });
    const args = buildDockerRunArgs(spec);
    expect(args).toContain("--dns");
    for (const dns of WORKER_DNS_SERVERS) {
      expect(args).toContain(dns);
    }
    expect(args.indexOf("--dns")).toBeLessThan(args.indexOf(spec.image));
    expect(args).toContain("--read-only");
    expect(args).toContain(`${spec.worktreeHost}:/workspace`);
    expect(args).toContain(`${gradleCacheVolumeName("app-deadbeef")}:/gradle-cache`);
    expect(args).toContain(`${gradleBuildVolumeName("app-deadbeef")}:/gradle-build`);
    expect(args).toContain("GRADLE_USER_HOME=/gradle-cache");
    expect(args).toContain("ORG_GRADLE_PROJECT_org.gradle.vfs.watch=false");
    expect(args).toContain("ORG_GRADLE_PROJECT_org.gradle.parallel=true");
  });
});

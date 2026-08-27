import { describe, expect, it } from "vitest";
import {
  buildGradleInitEnsureArgs,
  buildVolumeCreateArgs,
  gradleBuildVolumeName,
  gradleCacheVolumeName,
  gradleInitScript,
  GRADLE_INIT_MARKER,
} from "../../src/domain/gradle-sandbox.js";

describe("gradle sandbox helpers", () => {
  it("names project-scoped Docker volumes", () => {
    expect(gradleCacheVolumeName("civcraft-deadbeef")).toBe("agent-harness-gradle-civcraft-deadbeef");
    expect(gradleBuildVolumeName("civcraft-deadbeef")).toBe("agent-harness-build-civcraft-deadbeef");
  });

  it("builds idempotent volume create args", () => {
    expect(buildVolumeCreateArgs("agent-harness-gradle-app")).toEqual([
      "volume",
      "create",
      "agent-harness-gradle-app",
    ]);
  });

  it("writes a Gradle init script that redirects build dirs", () => {
    const script = gradleInitScript();
    expect(script).toContain(GRADLE_INIT_MARKER);
    expect(script).toContain("/gradle-build/");
    const args = buildGradleInitEnsureArgs("agent-harness-gradle-app", "node:22-bookworm-slim");
    expect(args[0]).toBe("run");
    expect(args).toContain("agent-harness-gradle-app:/gradle-cache");
    expect(args).toContain("node:22-bookworm-slim");
  });
});

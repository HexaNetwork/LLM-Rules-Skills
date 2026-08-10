import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectVerificationEvidence,
  verificationEvidenceNeedsTools,
} from "../../src/application/verification-evidence.js";
import type { VerificationEvidence, VerificationSettingsSnapshot } from "../../src/domain.js";

const SETTINGS: VerificationSettingsSnapshot = {
  workflow: { testPathPatterns: ["**/*.test.ts"] },
  commands: { test: "npm test" },
};

describe("collectVerificationEvidence", () => {
  const roots: string[] = [];

  afterEach(async () => {
    // Temp dirs are left for OS cleanup; track only for path assertions.
    roots.length = 0;
  });

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "agent-harness-evidence-"));
    roots.push(root);
    return root;
  }

  async function write(root: string, relative: string, contents: string): Promise<void> {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }

  it("reports an empty root checklist when no manifests exist", async () => {
    const root = await tempRoot();
    await write(root, "README.md", "# empty\n");

    const evidence = await collectVerificationEvidence(root, SETTINGS);
    expect(evidence.sampleTestPaths).toEqual([]);
    expect(evidence.manifests.length).toBeGreaterThan(0);
    expect(evidence.manifests.every((entry) => entry.present === false)).toBe(true);
    expect(evidence.manifests.some((entry) => entry.path === "settings.gradle.kts")).toBe(true);
    expect(evidence.manifests.some((entry) => entry.path === "gradlew")).toBe(true);
    expect(evidence.host.platform).toBe(process.platform);
    expect(evidence.host.isWindows).toBe(process.platform === "win32");
    expect(verificationEvidenceNeedsTools(evidence)).toBe(true);
  });

  it("finds nested Gradle/Maven manifests and sample src/main/test paths", async () => {
    const root = await tempRoot();
    await write(root, "settings.gradle.kts", 'rootProject.name = "emperor"\n');
    await write(root, "gradlew", "#!/bin/sh\necho gradle\n");
    await write(root, "civcraft/build.gradle.kts", "plugins { java }\n");
    await write(root, "tools/CoreProtect/pom.xml", "<project></project>\n");
    await write(
      root,
      "civcraft/src/main/test/com/example/ThingTest.java",
      "class ThingTest {}\n",
    );

    const evidence = await collectVerificationEvidence(root, SETTINGS);
    const present = evidence.manifests.filter((entry) => entry.present).map((entry) => entry.path);

    expect(present).toContain("settings.gradle.kts");
    expect(present).toContain("gradlew");
    expect(present).toContain("civcraft/build.gradle.kts");
    expect(present).toContain("tools/CoreProtect/pom.xml");
    expect(evidence.sampleTestPaths).toContain(
      "civcraft/src/main/test/com/example/ThingTest.java",
    );

    const gradlew = evidence.manifests.find((entry) => entry.path === "gradlew");
    expect(gradlew?.excerpt).toBe("[wrapper script present]");
    expect(gradlew?.excerpt).not.toContain("#!/bin/sh");
  });

  it("skips heavy directories while still seeing sibling projects", async () => {
    const root = await tempRoot();
    await write(root, "node_modules/pkg/package.json", '{"name":"hidden"}\n');
    await write(root, "build/tmp/build.gradle.kts", "hidden\n");
    await write(root, "apps/api/package.json", '{"name":"api","scripts":{"test":"vitest"}}\n');

    const evidence = await collectVerificationEvidence(root, SETTINGS);
    const present = evidence.manifests.filter((entry) => entry.present).map((entry) => entry.path);

    expect(present).toContain("apps/api/package.json");
    expect(present).not.toContain("node_modules/pkg/package.json");
    expect(present).not.toContain("build/tmp/build.gradle.kts");
  });
});

describe("verificationEvidenceNeedsTools", () => {
  function evidence(
    partial: Pick<VerificationEvidence, "manifests" | "sampleTestPaths">,
  ): VerificationEvidence {
    return {
      ...partial,
      currentSettings: SETTINGS,
      host: { platform: process.platform, isWindows: process.platform === "win32" },
    };
  }

  it("treats single-stack nested Gradle evidence as strong", () => {
    expect(
      verificationEvidenceNeedsTools(
        evidence({
          manifests: [
            { path: "settings.gradle.kts", present: true, excerpt: "name" },
            { path: "gradlew", present: true, excerpt: "[wrapper script present]" },
            { path: "civcraft/build.gradle.kts", present: true, excerpt: "java" },
            { path: "package.json", present: false },
          ],
          sampleTestPaths: ["civcraft/src/main/test/ThingTest.java"],
        }),
      ),
    ).toBe(false);
  });

  it("treats multi-stack and empty evidence as needing tools", () => {
    expect(
      verificationEvidenceNeedsTools(
        evidence({
          manifests: [
            { path: "package.json", present: true, excerpt: "{}" },
            { path: "build.gradle.kts", present: true, excerpt: "java" },
          ],
          sampleTestPaths: [],
        }),
      ),
    ).toBe(true);

    expect(
      verificationEvidenceNeedsTools(
        evidence({
          manifests: [{ path: "package.json", present: false }],
          sampleTestPaths: [],
        }),
      ),
    ).toBe(true);
  });
});

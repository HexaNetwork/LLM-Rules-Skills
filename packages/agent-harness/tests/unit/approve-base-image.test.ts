import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeDockerClient } from "../../src/infrastructure/container/fake-docker-client.js";
import {
  approveKnownStackBaseImages,
  approveStackBaseImage,
  mergeApprovedBaseImageLists,
  mergeApprovedBaseImages,
} from "../../src/application/approve-base-image.js";
import { HarnessFailure } from "../../src/errors.js";
import { KNOWN_STACK_BASE_FAMILIES } from "../../src/application/execution-image-generator.js";

const NODE_PINNED =
  "node:22-bookworm@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const JVM_DIGEST = `sha256:${"c".repeat(64)}`;

describe("mergeApprovedBaseImages", () => {
  it("replaces a prior entry for the same family and keeps others", () => {
    const merged = mergeApprovedBaseImages(
      [NODE_PINNED, `eclipse-temurin:21-jdk-jammy@${JVM_DIGEST}`],
      "eclipse-temurin:21-jdk-jammy",
      `eclipse-temurin:21-jdk-jammy@sha256:${"d".repeat(64)}`,
    );
    expect(merged).toEqual([
      NODE_PINNED,
      `eclipse-temurin:21-jdk-jammy@sha256:${"d".repeat(64)}`,
    ]);
  });
});

describe("mergeApprovedBaseImageLists", () => {
  it("keeps the home catalog when the project omits approvedBaseImages", () => {
    expect(mergeApprovedBaseImageLists([NODE_PINNED], undefined)).toEqual([NODE_PINNED]);
  });

  it("lets a project entry override one family without dropping the rest", () => {
    const home = [
      NODE_PINNED,
      `eclipse-temurin:21-jdk-jammy@${JVM_DIGEST}`,
    ];
    const project = [
      `eclipse-temurin:21-jdk-jammy@sha256:${"e".repeat(64)}`,
    ];
    expect(mergeApprovedBaseImageLists(home, project)).toEqual([
      NODE_PINNED,
      `eclipse-temurin:21-jdk-jammy@sha256:${"e".repeat(64)}`,
    ]);
  });
});

describe("approveStackBaseImage", () => {
  it("pins a stack without a repository when --stack is provided", async () => {
    const docker = createFakeDockerClient({ healthy: true });
    const result = await approveStackBaseImage({
      docker,
      stack: "jvm",
      existingApprovedBaseImages: [],
    });
    expect(result.stack).toBe("jvm");
    expect(result.family).toBe("eclipse-temurin:21-jdk-jammy");
    expect(result.baseImageDigest).toMatch(
      /^eclipse-temurin:21-jdk-jammy@sha256:[a-f0-9]{64}$/i,
    );
  });

  it("pulls and pins the known JVM family for a Gradle project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-base-jvm-"));
    await writeFile(path.join(root, "settings.gradle.kts"), "rootProject.name = \"demo\"\n", "utf8");
    const docker = createFakeDockerClient({ healthy: true });
    const result = await approveStackBaseImage({
      docker,
      repositoryRoot: root,
      existingApprovedBaseImages: [],
    });
    expect(result.stack).toBe("jvm");
    expect(result.source).toBe("pulled");
    expect(result.approvedBaseImages).toEqual([result.baseImageDigest]);
  });

  it("fails closed when the stack is ambiguous", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-base-amb-"));
    await writeFile(path.join(root, "package.json"), '{"name":"demo"}\n', "utf8");
    await writeFile(path.join(root, "pom.xml"), "<project/>\n", "utf8");
    const docker = createFakeDockerClient({ healthy: true });
    await expect(
      approveStackBaseImage({ docker, repositoryRoot: root }),
    ).rejects.toBeInstanceOf(HarnessFailure);
  });
});

describe("approveKnownStackBaseImages", () => {
  it("pins every known stack family into one shared catalog", async () => {
    const docker = createFakeDockerClient({ healthy: true });
    const result = await approveKnownStackBaseImages({
      docker,
      existingApprovedBaseImages: [],
    });
    const stacks = Object.keys(KNOWN_STACK_BASE_FAMILIES);
    expect(result.bases.map((base) => base.stack).sort()).toEqual([...stacks].sort());
    expect(result.approvedBaseImages).toHaveLength(stacks.length);
    for (const image of result.approvedBaseImages) {
      expect(image).toMatch(/@sha256:[a-f0-9]{64}$/i);
    }
  });
});

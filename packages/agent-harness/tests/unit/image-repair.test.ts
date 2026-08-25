import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readRunDockerfile,
  runDockerfilePath,
  runImageTag,
  validateRepairedDockerfile,
} from "../../src/domain/image-repair.js";
import { createTempDir } from "../helpers.js";

const BASE_DOCKERFILE = [
  "FROM node:22-bookworm-slim",
  "",
  "WORKDIR /opt/agent-harness",
  "COPY package.json ./",
  "RUN npm install --omit=dev",
  "COPY dist ./dist",
  "",
  "USER 10001:10001",
  "WORKDIR /workspace",
  'CMD ["sleep", "infinity"]',
  "",
].join("\n");

describe("runImageTag", () => {
  it("sanitizes unsafe run id characters", () => {
    expect(runImageTag("abc 123/x")).toBe("agent-harness-worker-run-abc-123-x");
  });
});

describe("runDockerfilePath", () => {
  it("nests the Dockerfile under runs/<runId>/image", () => {
    expect(runDockerfilePath("/home", "r1")).toBe(
      path.join("/home", "runs", "r1", "image", "Dockerfile"),
    );
  });
});

describe("validateRepairedDockerfile", () => {
  it("accepts the base Dockerfile with an added apt-get install layer", () => {
    const repaired = BASE_DOCKERFILE.replace(
      "USER 10001:10001",
      "RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*\n\nUSER 10001:10001",
    );
    expect(validateRepairedDockerfile(BASE_DOCKERFILE, repaired)).toBeUndefined();
  });

  it("rejects an empty Dockerfile", () => {
    expect(validateRepairedDockerfile(BASE_DOCKERFILE, "")).toBe(
      "Repaired Dockerfile is empty",
    );
  });

  it("rejects a changed base image", () => {
    const repaired = BASE_DOCKERFILE.replace(
      "FROM node:22-bookworm-slim",
      "FROM alpine:3",
    );
    expect(validateRepairedDockerfile(BASE_DOCKERFILE, repaired)).toBe(
      "Repaired Dockerfile must keep the base image `FROM node:22-bookworm-slim`",
    );
  });

  it("rejects content missing the USER line", () => {
    const repaired = BASE_DOCKERFILE.replace("USER 10001:10001\n", "");
    expect(validateRepairedDockerfile(BASE_DOCKERFILE, repaired)).toBe(
      "Repaired Dockerfile must keep `USER 10001:10001`",
    );
  });
});

describe("readRunDockerfile", () => {
  it("returns undefined for a missing file", async () => {
    const harnessHome = await createTempDir("harness-image-repair-");
    await expect(readRunDockerfile(harnessHome, "no-such-run")).resolves.toBeUndefined();
  });
});

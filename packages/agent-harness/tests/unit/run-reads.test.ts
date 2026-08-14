import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRunState, type ReflectOutput } from "../../src/domain.js";
import { HarnessConfigSchema } from "../../src/config/schema.js";
import { RunStore } from "../../src/store.js";
import {
  allowedArtifact,
  readExecutionImage,
  summarizeRun,
} from "../../src/ui/http/run-reads.js";

const reflectOutput = (overrides: Partial<ReflectOutput> = {}): ReflectOutput => ({
  proposedTitle: "Add greeting tone",
  summary: "Restated greeting feature",
  restatement: "Add a greeting feature with a chosen tone.",
  goal: "Ship a greeting users understand",
  users: ["end users"],
  inScope: ["tone choice"],
  outOfScope: [],
  assumptions: [],
  unknowns: [],
  ...overrides});

describe("summarizeRun title", () => {
  const now = "2026-01-01T00:00:00.000Z";

  it("prefers confirmedStructured.proposedTitle over structured and idea", () => {
    const state = createRunState("title-run", "Long raw idea text for the greeting feature", now);
    state.reflectBrief = {
      draft: "draft brief",
      structured: reflectOutput({ proposedTitle: "Draft title" }),
      confirmed: "confirmed brief",
      confirmedStructured: reflectOutput({ proposedTitle: "Confirmed title" }),
      confirmedAt: now};

    const summary = summarizeRun(state);
    expect(summary.title).toBe("Confirmed title");
    expect(summary.idea).toBe("Long raw idea text for the greeting feature");
  });

  it("falls back to structured.proposedTitle before confirm", () => {
    const state = createRunState("draft-title-run", "Raw idea", now);
    state.reflectBrief = {
      draft: "draft brief",
      structured: reflectOutput({ proposedTitle: "Draft title" })};

    expect(summarizeRun(state).title).toBe("Draft title");
  });

  it("omits title when neither structured nor confirmed proposedTitle exists", () => {
    const state = createRunState("legacy-title-run", "Raw idea", now);
    state.reflectBrief = {
      draft: "draft brief",
      structured: reflectOutput({ proposedTitle: undefined })};
    delete state.reflectBrief.structured!.proposedTitle;

    expect(summarizeRun(state).title).toBeUndefined();
  });
});

describe("execution-image artifacts", () => {
  it("allows known execution-image paths and rejects others", () => {
    expect(allowedArtifact("execution-image/Dockerfile")).toBe(true);
    expect(allowedArtifact("execution-image/profile.json")).toBe(true);
    expect(allowedArtifact("execution-image/build.log")).toBe(true);
    expect(allowedArtifact("execution-image/../state.json")).toBe(false);
    expect(allowedArtifact("execution-image/secret.env")).toBe(false);
  });

  it("reads Dockerfile and profile for the run UI", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "ah-run-reads-"));
    const runId = "img-run";
    const imageDir = path.join(stateRoot, "runs", runId, "execution-image");
    await mkdir(imageDir, { recursive: true });
    await writeFile(path.join(imageDir, "Dockerfile"), "FROM node:22\n", "utf8");
    await writeFile(
      path.join(imageDir, "profile.json"),
      JSON.stringify({ stack: "node", baseImage: "node:22-bookworm@sha256:abc" }),
      "utf8",
    );
    await writeFile(path.join(imageDir, "Dockerfile.sha256"), "deadbeef\n", "utf8");

    const store = new RunStore(HarnessConfigSchema.parse({}), stateRoot);
    const image = await readExecutionImage(store, runId);
    expect(image.present).toBe(true);
    expect(image.dockerfile).toContain("FROM node:22");
    expect(image.profile?.stack).toBe("node");
    expect(image.dockerfileHash).toBe("deadbeef");
    expect(image.files).toContain("execution-image/Dockerfile");
  });

  it("returns present:false when no execution-image directory exists", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "ah-run-reads-empty-"));
    const store = new RunStore(HarnessConfigSchema.parse({}), stateRoot);
    await mkdir(path.join(stateRoot, "runs", "empty-run"), { recursive: true });
    const image = await readExecutionImage(store, "empty-run");
    expect(image).toEqual({ present: false, files: [] });
  });
});

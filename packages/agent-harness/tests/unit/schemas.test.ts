import { describe, expect, it } from "vitest";
import {
  ProjectConfigSchema,
  FindingSchema,
  DraftManifestSchema,
  WorkerReportSchema,
  VerifierReportSchema,
} from "../../src/schemas/index.js";
import {
  approveManifest,
  validateTasksForPrepare,
} from "../../src/engine/prepare.js";
import type { ManifestTask } from "../../src/schemas/manifest.js";

describe("schemas", () => {
  it("parses project config with defaults", () => {
    const config = ProjectConfigSchema.parse({
      contractVersion: "1",
      name: "demo",
      models: {
        prepare: "m",
        worker: "m",
        verifier: "m",
        repair: "m",
        adversarial: "m",
      },
      commandGates: [{ id: "build", command: "npm run build" }],
    });
    expect(config.retries.commandOrSpecRepairs).toBe(2);
    expect(config.pathPolicy.protectedGlobs.length).toBeGreaterThan(0);
  });

  it("rejects unknown contract version", () => {
    expect(() =>
      ProjectConfigSchema.parse({
        contractVersion: "9",
        name: "demo",
        models: {
          prepare: "m",
          worker: "m",
          verifier: "m",
          repair: "m",
          adversarial: "m",
        },
        commandGates: [{ id: "build", command: "npm run build" }],
      }),
    ).toThrow();
  });

  it("accepts BLOCKING and ADVISORY findings only", () => {
    expect(
      FindingSchema.parse({
        id: "f1",
        severity: "BLOCKING",
        criterionOrRule: "ac-1",
        location: "src/a.ts:1",
        evidence: "missing export",
        remediation: "add export",
      }).severity,
    ).toBe("BLOCKING");
    expect(() =>
      FindingSchema.parse({
        id: "f1",
        severity: "Critical",
        criterionOrRule: "ac-1",
        location: "src/a.ts:1",
        evidence: "x",
        remediation: "y",
      }),
    ).toThrow();
  });

  it("parses worker and verifier reports", () => {
    WorkerReportSchema.parse({
      contractVersion: "1",
      taskId: "t1",
      summary: "done",
    });
    VerifierReportSchema.parse({
      contractVersion: "1",
      taskId: "t1",
      acceptance: [{ criterionId: "ac-1", satisfied: true, evidence: "ok" }],
    });
  });
});

describe("prepare validation", () => {
  const afkTask = (overrides: Partial<ManifestTask> = {}): ManifestTask => ({
    id: "t1",
    title: "Task",
    mode: "AFK",
    body: "",
    acceptanceCriteria: [{ id: "ac-1", text: "Ship the feature correctly" }],
    blockedBy: [],
    allowedGlobs: ["**/*"],
    testSeams: [],
    browserProbes: [],
    ...overrides,
  });

  it("rejects HITL tasks", () => {
    const errors = validateTasksForPrepare([afkTask({ mode: "HITL" })]);
    expect(errors.some((error) => error.includes("HITL"))).toBe(true);
  });

  it("refuses approve when draft has validation errors", async () => {
    const draft = DraftManifestSchema.parse({
      contractVersion: "1",
      draft: true,
      createdAt: new Date().toISOString(),
      source: {
        kind: "local",
        location: "/tmp/x",
        contentHash: "abc",
        fetchedAt: new Date().toISOString(),
      },
      configSnapshot: ProjectConfigSchema.parse({
        contractVersion: "1",
        name: "demo",
        models: {
          prepare: "m",
          worker: "m",
          verifier: "m",
          repair: "m",
          adversarial: "m",
        },
        commandGates: [{ id: "build", command: "npm run build" }],
      }),
      tasks: [afkTask({ mode: "HITL" })],
      validationErrors: ["HITL"],
    });
    await expect(
      approveManifest({ draft, approvedBy: "me" }),
    ).rejects.toThrow(/validation errors/);
  });
});

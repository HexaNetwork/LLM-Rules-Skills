import { afterEach, describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import { WorkerHarnessRuntime } from "../../src/application/harness-engine.js";
import { withDiagnosticArtifacts } from "../testkit/diagnostics.js";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";

const REFLECT_OUTPUT = {
  proposedTitle: "Add greeting tone",
  summary: "Restated greeting feature",
  restatement: "Add a greeting feature with a chosen tone.",
  goal: "Ship a greeting users understand",
  users: ["end users"],
  inScope: ["tone"],
  outOfScope: [],
  assumptions: [],
  unknowns: [],
};

describe("Phase 5 stale-lock recovery", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
  });

  it("allows concurrent workspace advances without corrupting either run", async () => {
    fixture = await createProjectFixture({
      config: {
        agent: { promptBuilder: false, schemaRepairAttempts: 0, timeoutMs: 5_000, provider: "cursor" },
        workflow: {},
        knowledge: { repositoryIntelligence: { enabled: false }, guidance: { enabled: false } },
      },
    });

    await withDiagnosticArtifacts(
      { testName: "duplicate-advance-serialization", fixture },
      async () => {
        let releaseA!: () => void;
        let releaseB!: () => void;
        let startedA!: () => void;
        let startedB!: () => void;
        const aStarted = new Promise<void>((resolve) => {
          startedA = resolve;
        });
        const bStarted = new Promise<void>((resolve) => {
          startedB = resolve;
        });
        const aHold = new Promise<void>((resolve) => {
          releaseA = resolve;
        });
        const bHold = new Promise<void>((resolve) => {
          releaseB = resolve;
        });

        const engineA = new WorkerHarnessRuntime(fixture!.config, {
          backend: createFakeBackend({
            reflector: async () => {
              startedA();
              await aHold;
              return REFLECT_OUTPUT;
            },
          }),
        });
        const engineB = new WorkerHarnessRuntime(fixture!.config, {
          backend: createFakeBackend({
            reflector: async () => {
              startedB();
              await bHold;
              return REFLECT_OUTPUT;
            },
          }),
        });
        const runA = await engineA.start("Idea A", "dup-a", false, false);
        const runB = await engineB.start("Idea B", "dup-b", false, false);

        const first = engineA.advance(runA.runId);
        const second = engineB.advance(runB.runId);
        await Promise.all([aStarted, bStarted]);
        expect(await engineA.store.inspectRepositoryLock()).toBeNull();

        releaseA();
        releaseB();
        const [finishedA, finishedB] = await Promise.all([first, second]);
        expect(finishedA.phase).toBe("awaiting_input");
        expect(finishedB.phase).toBe("awaiting_input");
      },
    );
  });
});

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/agent.js";
import { HarnessEngine } from "../../src/engine.js";
import { withDiagnosticArtifacts } from "../testkit/diagnostics.js";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";

const REFLECT_OUTPUT = {
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

  it("blocks on an abandoned repository lock until unlock --repo clears it", async () => {
    fixture = await createProjectFixture({
      config: {
        agent: { promptBuilder: false, schemaRepairAttempts: 0, timeoutMs: 2_000, provider: "cursor" },
        workflow: { tdd: false },
        knowledge: { graphify: { enabled: false }, guidance: { enabled: false } },
      },
    });

    await withDiagnosticArtifacts(
      { testName: "stale-lock-recovery-unlock", fixture },
      async () => {
        const backend = createFakeBackend({
          reflector: () => REFLECT_OUTPUT,
        });
        const engine = new HarnessEngine(fixture!.config, { backend });
        const started = await engine.start("Recover from stale lock", "stale-lock-run", false, false);

        await mkdir(path.join(fixture!.root, ".agent-harness"), { recursive: true });
        await writeFile(
          path.join(fixture!.root, ".agent-harness", "repo.lock"),
          `${JSON.stringify({
            pid: 9_999_991,
            hostname: "gone-host",
            at: new Date(0).toISOString(),
            runId: "dead-run",
            action: "advance",
          })}\n`,
          "utf8",
        );

        await expect(engine.advance(started.runId)).rejects.toThrow(
          /repository is in use by run dead-run/i,
        );
        expect(await engine.store.inspectRepositoryLock()).not.toBeNull();

        const unlocked = await engine.store.unlock(started.runId, { repo: true });
        expect(unlocked.repo).toBe(true);
        expect(await engine.store.inspectRepositoryLock()).toBeNull();

        const advanced = await engine.advance(started.runId);
        expect(advanced.phase).toBe("awaiting_input");
      },
    );
  });

  it("serializes duplicate advance attempts without corrupting either run", async () => {
    fixture = await createProjectFixture({
      config: {
        agent: { promptBuilder: false, schemaRepairAttempts: 0, timeoutMs: 5_000, provider: "cursor" },
        workflow: { tdd: false },
        knowledge: { graphify: { enabled: false }, guidance: { enabled: false } },
      },
    });

    await withDiagnosticArtifacts(
      { testName: "duplicate-advance-serialization", fixture },
      async () => {
        let release!: () => void;
        let reflecting!: () => void;
        const startedReflect = new Promise<void>((resolve) => {
          reflecting = resolve;
        });
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });

        const backend = createFakeBackend({
          reflector: async () => {
            reflecting();
            await hold;
            return REFLECT_OUTPUT;
          },
        });
        const engine = new HarnessEngine(fixture!.config, { backend });
        const runA = await engine.start("Idea A", "dup-a", false, false);
        const runB = await engine.start("Idea B", "dup-b", false, false);

        const first = engine.advance(runA.runId);
        await startedReflect;
        await expect(engine.advance(runB.runId)).rejects.toThrow(/repository is in use by run dup-a/i);

        release();
        const finished = await first;
        expect(finished.phase).toBe("awaiting_input");
        expect((await engine.status(runB.runId)).phase).toBe("new");
      },
    );
  });
});

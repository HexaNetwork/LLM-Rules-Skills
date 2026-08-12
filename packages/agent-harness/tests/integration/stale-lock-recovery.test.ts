import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/agent.js";
import { HarnessEngine } from "../../src/engine.js";
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
  unknowns: []};

describe("Phase 5 stale-lock recovery", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
  });

  it("ignores an abandoned repository lock for non-legacy workspaces", async () => {
    fixture = await createProjectFixture({
      config: {
        agent: { promptBuilder: false, schemaRepairAttempts: 0, timeoutMs: 2_000, provider: "cursor" },
        workflow: { },
        knowledge: { graphify: { enabled: false }, guidance: { enabled: false } }}});

    await withDiagnosticArtifacts(
      { testName: "stale-lock-recovery-unlock", fixture },
      async () => {
        const backend = createFakeBackend({
          reflector: () => REFLECT_OUTPUT});
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
            action: "advance"})}\n`,
          "utf8",
        );

        // git-disabled / worktree runs no longer take the repository lock.
        const advanced = await engine.advance(started.runId);
        expect(advanced.phase).toBe("awaiting_input");
        expect(await engine.store.inspectRepositoryLock()).not.toBeNull();

        const unlocked = await engine.store.unlock(started.runId, { repo: true });
        expect(unlocked.repo).toBe(true);
        expect(await engine.store.inspectRepositoryLock()).toBeNull();
      },
    );
  });

  it("blocks legacy-shared advances on an abandoned repository lock until unlock --repo", async () => {
    fixture = await createProjectFixture({
      config: {
        agent: { promptBuilder: false, schemaRepairAttempts: 0, timeoutMs: 2_000, provider: "cursor" },
        workflow: { },
        knowledge: { graphify: { enabled: false }, guidance: { enabled: false } }}});

    await withDiagnosticArtifacts(
      { testName: "stale-lock-recovery-legacy-unlock", fixture },
      async () => {
        const backend = createFakeBackend({
          reflector: () => REFLECT_OUTPUT});
        const engine = new HarnessEngine(fixture!.config, { backend });
        const started = await engine.start("Recover from stale lock", "stale-lock-legacy", false, false);
        await engine.store.writeJson(started.runId, "workspace.json", {
          version: 1,
          kind: "legacy-shared",
          controlRoot: fixture!.root,
          createdAt: new Date().toISOString()});

        await mkdir(path.join(fixture!.root, ".agent-harness"), { recursive: true });
        await writeFile(
          path.join(fixture!.root, ".agent-harness", "repo.lock"),
          `${JSON.stringify({
            pid: 9_999_991,
            hostname: "gone-host",
            at: new Date(0).toISOString(),
            runId: "dead-run",
            action: "advance"})}\n`,
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

  it("allows concurrent non-legacy advances without corrupting either run", async () => {
    fixture = await createProjectFixture({
      config: {
        agent: { promptBuilder: false, schemaRepairAttempts: 0, timeoutMs: 5_000, provider: "cursor" },
        workflow: { },
        knowledge: { graphify: { enabled: false }, guidance: { enabled: false } }}});

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

        const engineA = new HarnessEngine(fixture!.config, {
          backend: createFakeBackend({
            reflector: async () => {
              startedA();
              await aHold;
              return REFLECT_OUTPUT;
            }})});
        const engineB = new HarnessEngine(fixture!.config, {
          backend: createFakeBackend({
            reflector: async () => {
              startedB();
              await bHold;
              return REFLECT_OUTPUT;
            }})});
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

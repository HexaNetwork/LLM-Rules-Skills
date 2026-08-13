import { HIGH_LEVEL_PLAN, PRD_OUTPUT } from "../helpers.js";
import path from "node:path";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createScriptedBackend } from "../testkit/scripted-backend.js";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";
import { withDiagnosticArtifacts } from "../testkit/diagnostics.js";
import {
  ACCEPTANCE_GRILL_QUESTION,
  ACCEPTANCE_REFLECT,
  runCli,
  writeAcceptanceConfig} from "./helpers.js";

describe("CLI acceptance lifecycle", () => {
  let fixture: ProjectFixture | undefined;
  let previousCwd: string | undefined;

  afterEach(async () => {
    if (previousCwd) process.chdir(previousCwd);
    previousCwd = undefined;
    await fixture?.cleanup();
    fixture = undefined;
  });

  it("init writes a valid config and ignores harness state", async () => {
    fixture = await createProjectFixture();
    previousCwd = process.cwd();
    process.chdir(fixture.root);

    await withDiagnosticArtifacts({ testName: "acceptance-init", fixture }, async () => {
      const result = await runCli(["init"]);
      expect(result.code).toBe(0);
      expect(result.stdout.join("\n")).toMatch(/Wrote .*agent-harness\.config\.yaml/);

      const configPath = path.join(fixture!.root, "agent-harness.config.yaml");
      await access(configPath);
      const gitignore = await readFile(path.join(fixture!.root, ".gitignore"), "utf8");
      expect(gitignore).toContain(".agent-harness/");
      expect(gitignore).toContain("graphify-out/");
      const graphifyignore = await readFile(path.join(fixture!.root, ".graphifyignore"), "utf8");
      expect(graphifyignore).toContain("agent-harness/");
      expect(graphifyignore).toContain("**/_*.txt");
      await access(path.join(fixture!.root, ".agent-harness"));
      await expect(access(path.join(fixture!.root, "agent-harness", "scripts"))).rejects.toThrow();
      await expect(access(path.join(fixture!.root, "agent-harness", "guidance"))).rejects.toThrow();
    });
  });

  it("start → status --json → answer → continue → confirm-grill completes a scripted workflow", async () => {
    fixture = await createProjectFixture({
      config: {
        agent: { promptBuilder: false, schemaRepairAttempts: 0, timeoutMs: 5_000 },
        workflow: { generateCommitMessages: false },
        knowledge: { graphify: { enabled: false }, guidance: { enabled: false } }}});
    const configPath = await writeAcceptanceConfig(fixture);
    const scripted = createScriptedBackend([
      { role: "reflector", output: ACCEPTANCE_REFLECT },
      {
        role: "griller",
        output: {
          status: "needs_input",
          summary: "Need tone",
          questions: [ACCEPTANCE_GRILL_QUESTION]}},
      {
        role: "griller",
        output: {
          status: "ready_to_plan",
          summary: "Tone decided",
          resolutions: [
            {
              id: "tone",
              question: ACCEPTANCE_GRILL_QUESTION.prompt,
              answer: "Casual",
              summary: "Use a casual greeting"}]}},
      { role: "planner", output: HIGH_LEVEL_PLAN },
      { role: "planner", output: PRD_OUTPUT },
      {
        role: "issue-slicer",
        output: {

          summary: "One task",
          tasks: [
            {
              id: "greet",
              title: "Ship greeting",
              description: "Render greeting",
              acceptanceCriteria: ["Works"],
              blockedBy: []}],
          proposedInstalls: []}},
      { role: "implementer", output: { summary: "Built", changedFiles: ["src/greet.ts"] } },
      { role: "task-reviewer", output: { approved: true, summary: "ok", findings: [] } },
      { role: "reviewer", output: { approved: true, summary: "ok", findings: [] } }]);

    await withDiagnosticArtifacts({ testName: "acceptance-lifecycle", fixture }, async () => {
      const deps = { createBackend: () => scripted.backend };
      const runId = "acceptance-lifecycle-run";

      const started = await runCli(
        ["start", "--idea", "Add a greeting feature", "--config", configPath, "--run-id", runId, "--tdd", "off"],
        deps,
      );
      expect(started.code).toBe(0);
      expect(started.stdout.join("\n")).toMatch(/awaiting_input/);

      const status = await runCli(["status", "--run-id", runId, "--config", configPath, "--json"], deps);
      expect(status.code).toBe(0);
      const state = JSON.parse(status.stdout.join("\n")) as {
        phase: string;
        activeQuestionId?: string;
        questions: Array<{ id: string; purpose?: string }>;
      };
      expect(state.phase).toBe("awaiting_input");
      const reflectId = state.activeQuestionId!;
      expect(state.questions.find((q) => q.id === reflectId)?.purpose).toBe("reflect");

      const answeredReflect = await runCli(
        [
          "answer",
          "--run-id",
          runId,
          "--config",
          configPath,
          "--question",
          reflectId,
          "--text",
          "Confirmed brief: casual greeting."],
        deps,
      );
      expect(answeredReflect.code).toBe(0);

      const grillStatus = await runCli(
        ["status", "--run-id", runId, "--config", configPath, "--json"],
        deps,
      );
      const grillState = JSON.parse(grillStatus.stdout.join("\n")) as {
        activeQuestionId?: string;
        questions: Array<{ id: string; purpose?: string }>;
      };
      const grillId = grillState.activeQuestionId!;
      expect(grillState.questions.find((q) => q.id === grillId)?.purpose).toBe("grill");

      const answeredGrill = await runCli(
        ["answer", "--run-id", runId, "--config", configPath, "--question", grillId, "--text", "Casual"],
        deps,
      );
      expect(answeredGrill.code).toBe(0);
      expect(answeredGrill.stdout.join("\n")).toMatch(/Grilling complete|confirm-grill/i);

      const confirmed = await runCli(
        ["confirm-grill", "--run-id", runId, "--config", configPath],
        deps,
      );
      expect(confirmed.code).toBe(0);

      const verificationStatus = await runCli(
        ["status", "--run-id", runId, "--config", configPath, "--json"],
        deps,
      );
      const verificationState = JSON.parse(verificationStatus.stdout.join("\n")) as {
        phase: string;
        verificationReady?: { summary?: string };
      };
      expect(verificationState.phase).toBe("awaiting_input");
      expect(verificationState.verificationReady?.summary).toBeTruthy();

      const confirmedVerification = await runCli(
        ["confirm-verification", "--run-id", runId, "--config", configPath],
        deps,
      );
      expect(confirmedVerification.code).toBe(0);

      const planStatus = await runCli(
        ["status", "--run-id", runId, "--config", configPath, "--json"],
        deps,
      );
      const planState = JSON.parse(planStatus.stdout.join("\n")) as {
        phase: string;
        planReady?: { summary?: string };
      };
      expect(planState.phase).toBe("awaiting_input");
      expect(planState.planReady?.summary).toBeTruthy();

      const confirmedPlan = await runCli(
        ["confirm-plan", "--run-id", runId, "--config", configPath],
        deps,
      );
      expect(confirmedPlan.code).toBe(0);

      const continued = await runCli(
        ["continue", "--run-id", runId, "--config", configPath],
        deps,
      );
      expect(continued.code).toBe(0);

      const finalStatus = await runCli(
        ["status", "--run-id", runId, "--config", configPath, "--json"],
        deps,
      );
      const finalState = JSON.parse(finalStatus.stdout.join("\n")) as {
        phase: string;
        tasks: Array<{ status: string }>;
      };
      expect(finalState.phase).toBe("completed");
      expect(finalState.tasks[0]?.status).toBe("done");
      scripted.assertExhausted();
    });
  });

  it("cancel, unlock, dirty control start, and cleanup work against real fixture files", async () => {
    fixture = await createProjectFixture({
      config: {
        agent: { promptBuilder: false, schemaRepairAttempts: 0, timeoutMs: 10_000 },
        workflow: { },
        git: { enabled: true, autoCommitPreflight: false },
        knowledge: { graphify: { enabled: false }, guidance: { enabled: false } }}});
    const configPath = await writeAcceptanceConfig(fixture, {
      git: { enabled: true, autoCommitPreflight: false }});
    await fixture.initGit();
    await fixture.write("surprise.txt", "dirty\n");

    let release!: () => void;
    let reflecting!: () => void;
    const startedReflect = new Promise<void>((resolve) => {
      reflecting = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scripted = createScriptedBackend([
      { role: "reflector", waitFor: hold, output: ACCEPTANCE_REFLECT }]);
    const originalRun = scripted.backend.run.bind(scripted.backend);
    scripted.backend.run = async (request) => {
      if (request.role === "reflector") reflecting();
      return originalRun(request);
    };

    await withDiagnosticArtifacts({ testName: "acceptance-cancel-unlock-cleanup", fixture }, async () => {
      const deps = { createBackend: () => scripted.backend };

      // Dirty control checkout is ignored for worktree runs (no notice).
      const noticeId = "acceptance-dirty-notice";
      const noticed = await runCli(
        [
          "start",
          "--idea",
          "Dirty control notice",
          "--config",
          configPath,
          "--run-id",
          noticeId,
          "--tdd",
          "off",
          "--no-advance"],
        deps,
      );
      expect(noticed.code).toBe(0);
      expect(noticed.stdout.join("\n")).not.toMatch(/^Notice:/m);
      expect(noticed.stdout.join("\n")).not.toMatch(/control checkout has uncommitted/i);
      expect(noticed.stdout.join("\n")).not.toMatch(/phase: blocked|blockedFrom/i);

      const refuseCommit = await runCli(
        ["retry", "--run-id", noticeId, "--config", configPath, "--commit-dirty", "branch-then-commit"],
        deps,
      );
      expect(refuseCommit.code).not.toBe(0);

      // Cancel while a later advance is in flight.
      const runId = "acceptance-cancel-run";
      const startPromise = runCli(
        ["start", "--idea", "Cancel me", "--config", configPath, "--run-id", runId, "--tdd", "off"],
        deps,
      );
      await startedReflect;

      const cancelled = await runCli(["cancel", "--run-id", runId, "--config", configPath], deps);
      expect(cancelled.code).toBe(0);
      expect(cancelled.stdout.join("\n")).toMatch(/cancel/i);
      release();
      await startPromise;

      const status = await runCli(["status", "--run-id", runId, "--config", configPath, "--json"], deps);
      expect(JSON.parse(status.stdout.join("\n")).phase).toBe("cancelled");

      const cleaned = await runCli(
        ["cleanup", "--run-id", runId, "--config", configPath],
        deps,
      );
      expect(cleaned.code).toBe(0);
      expect(cleaned.stdout.join("\n")).toMatch(/Removed worktree|Cleanup no-op/i);

      // Inspect remaining locks after cleanup (repository lock is no longer a product surface).
      const unlocked = await runCli(
        ["unlock", "--run-id", runId, "--inspect-only", "--config", configPath],
        deps,
      );
      expect(unlocked.code).toBe(0);
      expect(unlocked.stdout.join("\n")).toMatch(/workspace-admin|shared-index/i);

      const unlockedRemove = await runCli(
        ["unlock", "--run-id", runId, "--config", configPath],
        deps,
      );
      expect(unlockedRemove.code).toBe(0);
    });
  });

});

import { describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ProjectConfigSchema } from "../../src/schemas/config.js";
import { runLifecycle } from "../../src/engine/lifecycle.js";
import { createFakeAgentPort } from "../../src/agents/cursor-sdk.js";
import { createFakeGitHubPort } from "../../src/adapters/github.js";
import { startUiServer } from "../../src/ui/server.js";
import { gitOk } from "../../src/util/git.js";
import { loadRunState } from "../../src/engine/state-machine.js";
import type { RunEvent } from "../../src/schemas/reports.js";

async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-harness-life-"));
  await gitOk(root, ["init"]);
  await gitOk(root, ["config", "user.email", "test@example.com"]);
  await gitOk(root, ["config", "user.name", "Test"]);
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: {
        typecheck: "node -e \"process.exit(0)\"",
        "test:run":
          "node -e \"const fs=require('fs');process.exit(fs.existsSync('PASS')?0:1)\"",
        build: "node -e \"process.exit(0)\"",
      },
    }),
    "utf8",
  );
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "export {}\n", "utf8");
  await gitOk(root, ["add", "-A"]);
  await gitOk(root, ["commit", "-m", "init"]);
  await gitOk(root, ["branch", "-M", "main"]);
  return root;
}

function configFor(root: string) {
  return ProjectConfigSchema.parse({
    contractVersion: "1",
    name: "fixture",
    repositoryRoot: root,
    baseBranch: "main",
    models: {
      prepare: "fake",
      worker: "fake",
      verifier: "fake",
      repair: "fake",
      adversarial: "fake",
    },
    commandGates: [
      { id: "typecheck", command: "npm run typecheck" },
      { id: "test", command: "npm run test:run" },
      { id: "build", command: "npm run build" },
    ],
    tdd: {
      policy: "enforced",
      defaultTestCommand: "npm run test:run",
      requireMeaningfulRed: true,
    },
  });
}

describe("lifecycle autonomy", () => {
  it("idea → refine → TDD → review → commit (fake agents)", async () => {
    const root = await fixtureRepo();
    const events: RunEvent[] = [];
    const agent = createFakeAgentPort({
      runTestAuthor: async ({ task, cwd }) => {
        await mkdir(path.join(cwd, "tests"), { recursive: true });
        await writeFile(
          path.join(cwd, "tests", `${task.id}.test.ts`),
          `// failing until PASS exists\n`,
          "utf8",
        );
        // Ensure RED: remove PASS if present
        try {
          const { unlink } = await import("node:fs/promises");
          await unlink(path.join(cwd, "PASS"));
        } catch {
          /* ok */
        }
        return {
          launch: { agentId: "ta", runId: "ta1", text: "{}" },
          report: {
            contractVersion: "1",
            taskId: task.id,
            summary: "tests",
            changedPaths: [`tests/${task.id}.test.ts`],
            testsAddedOrUpdated: [`tests/${task.id}.test.ts`],
            unresolvedRisks: [],
          },
        };
      },
      runImplementer: async ({ task, cwd }) => {
        await mkdir(path.join(cwd, "src"), { recursive: true });
        await writeFile(
          path.join(cwd, "src", `${task.id}.ts`),
          `export const ok = true;\n`,
          "utf8",
        );
        await writeFile(path.join(cwd, "PASS"), "1\n", "utf8");
        return {
          launch: { agentId: "impl", runId: "i1", text: "{}" },
          report: {
            contractVersion: "1",
            taskId: task.id,
            summary: "impl",
            changedPaths: [`src/${task.id}.ts`, "PASS"],
            testsAddedOrUpdated: [`tests/${task.id}.test.ts`],
            unresolvedRisks: [],
          },
        };
      },
    });

    const result = await runLifecycle({
      idea: "Add a trivial marker module for the harness fixture",
      runId: "life-1",
      config: configFor(root),
      deps: {
        agent,
        onEvent: (event) => {
          events.push(event);
        },
      },
    });

    expect(result.state.status).toBe("succeeded");
    expect(result.state.tasks[0]?.status).toBe("accepted");
    expect(result.state.tasks[0]?.tddEvidence.some((e) => e.phase === "RED")).toBe(
      true,
    );
    expect(
      result.state.tasks[0]?.tddEvidence.some((e) => e.phase === "GREEN"),
    ).toBe(true);
    expect(events.some((e) => e.type === "tdd.red")).toBe(true);
    expect(events.some((e) => e.type === "review.aggregated")).toBe(true);
    expect(events.some((e) => e.type === "task.accepted")).toBe(true);
  });

  it("pauses for DECISION_REQUIRED and resumes after answers", async () => {
    const root = await fixtureRepo();
    const agent = createFakeAgentPort({
      runPlanner: async ({ intake }) => ({
        launch: { agentId: "p", runId: "p1", text: "{}" },
        intake: {
          ...intake,
          updatedAt: new Date().toISOString(),
          unresolvedQuestions: [
            {
              id: "q-product",
              text: "Which brand name should the UI show?",
              classification: "DECISION_REQUIRED",
            },
          ],
          slices: [
            {
              id: "slice-1",
              title: "Brand string",
              summary: intake.idea,
              dependsOn: [],
              acceptanceCriteria: [
                { id: "ac-1", text: "Expose the chosen brand name" },
              ],
              allowedGlobs: ["src/**", "tests/**", "PASS"],
              testSeams: [],
              tddPolicy: "exempt_non_testable",
              tddExemptionReason: "fixture exemption",
            },
          ],
        },
      }),
      runImplementer: async ({ task, cwd }) => {
        await mkdir(path.join(cwd, "src"), { recursive: true });
        await writeFile(
          path.join(cwd, "src", `${task.id}.ts`),
          `export const brand = "Acme";\n`,
          "utf8",
        );
        await writeFile(path.join(cwd, "PASS"), "1\n", "utf8");
        return {
          launch: { agentId: "w", runId: "w1", text: "{}" },
          report: {
            contractVersion: "1",
            taskId: task.id,
            summary: "ok",
            changedPaths: [`src/${task.id}.ts`, "PASS"],
            testsAddedOrUpdated: [],
            unresolvedRisks: [],
          },
        };
      },
    });

    const paused = await runLifecycle({
      idea: "Show a brand name somewhere",
      runId: "pause-1",
      config: configFor(root),
      deps: { agent },
    });
    expect(paused.paused).toBe(true);
    expect(paused.state.status).toBe("awaiting_decision");

    const resumed = await runLifecycle({
      runId: "pause-1",
      resume: true,
      decisionAnswers: [
        { questionId: "q-product", answer: "Use Acme as the brand" },
      ],
      config: configFor(root),
      deps: { agent },
    });
    expect(resumed.state.status).toBe("succeeded");
  });

  it("persists agent failure as paused/resumable", async () => {
    const root = await fixtureRepo();
    const agent = createFakeAgentPort({
      runPlanner: async ({ intake }) => ({
        launch: { agentId: "p", runId: "p1", text: "{}" },
        intake: {
          ...intake,
          unresolvedQuestions: [],
          slices: [
            {
              id: "slice-1",
              title: "Boom",
              summary: intake.idea,
              dependsOn: [],
              acceptanceCriteria: [
                { id: "ac-1", text: "Should fail the agent on purpose" },
              ],
              allowedGlobs: ["src/**", "tests/**", "PASS"],
              testSeams: [],
              tddPolicy: "exempt_non_testable",
              tddExemptionReason: "fixture exemption",
            },
          ],
        },
      }),
      runImplementer: async () => {
        throw new Error("simulated agent crash");
      },
    });

    const result = await runLifecycle({
      idea: "Crash mid-task",
      runId: "crash-1",
      config: configFor(root),
      deps: { agent },
    });
    expect(result.state.status).toBe("paused");
    expect(result.state.resumable).toBe(true);
    const state = await loadRunState(result.directory);
    expect(state.tasks[0]?.blockedReason).toBe("AGENT_FAILURE");

    let attempts = 0;
    const recoveryAgent = createFakeAgentPort({
      runImplementer: async ({ task, cwd }) => {
        attempts += 1;
        await mkdir(path.join(cwd, "src"), { recursive: true });
        await writeFile(
          path.join(cwd, "src", `${task.id}.ts`),
          `export const ok = true;\n`,
          "utf8",
        );
        await writeFile(path.join(cwd, "PASS"), "1\n", "utf8");
        return {
          launch: { agentId: "recover", runId: "r1", text: "{}" },
          report: {
            contractVersion: "1",
            taskId: task.id,
            summary: "recovered",
            changedPaths: [`src/${task.id}.ts`, "PASS"],
            testsAddedOrUpdated: [],
            unresolvedRisks: [],
          },
        };
      },
    });
    const resumed = await runLifecycle({
      runId: "crash-1",
      resume: true,
      config: configFor(root),
      deps: { agent: recoveryAgent },
    });
    expect(attempts).toBeGreaterThan(0);
    expect(resumed.state.status).toBe("succeeded");
  });

  it("pauses for DESTRUCTIVE_RISK and resumes after decide", async () => {
    const root = await fixtureRepo();
    const agent = createFakeAgentPort({
      runPlanner: async ({ intake }) => ({
        launch: { agentId: "p", runId: "p1", text: "{}" },
        intake: {
          ...intake,
          updatedAt: new Date().toISOString(),
          unresolvedQuestions: [
            {
              id: "q-drop",
              text: "Delete legacy user table?",
              classification: "DESTRUCTIVE_RISK",
            },
          ],
          slices: [
            {
              id: "slice-1",
              title: "Safe change",
              summary: intake.idea,
              dependsOn: [],
              acceptanceCriteria: [
                { id: "ac-1", text: "Apply the approved migration path" },
              ],
              allowedGlobs: ["src/**", "tests/**", "PASS"],
              testSeams: [],
              tddPolicy: "exempt_non_testable",
              tddExemptionReason: "fixture exemption",
            },
          ],
        },
      }),
      runImplementer: async ({ task, cwd }) => {
        await mkdir(path.join(cwd, "src"), { recursive: true });
        await writeFile(
          path.join(cwd, "src", `${task.id}.ts`),
          `export const migrated = true;\n`,
          "utf8",
        );
        await writeFile(path.join(cwd, "PASS"), "1\n", "utf8");
        return {
          launch: { agentId: "w", runId: "w1", text: "{}" },
          report: {
            contractVersion: "1",
            taskId: task.id,
            summary: "ok",
            changedPaths: [`src/${task.id}.ts`, "PASS"],
            testsAddedOrUpdated: [],
            unresolvedRisks: [],
          },
        };
      },
    });

    const paused = await runLifecycle({
      idea: "Migration with risk",
      runId: "destructive-1",
      config: configFor(root),
      deps: { agent },
    });
    expect(paused.paused).toBe(true);
    expect(paused.state.status).toBe("awaiting_decision");

    const resumed = await runLifecycle({
      runId: "destructive-1",
      resume: true,
      decisionAnswers: [
        { questionId: "q-drop", answer: "Do not delete; archive instead" },
      ],
      config: configFor(root),
      deps: { agent },
    });
    expect(resumed.state.status).toBe("succeeded");
    expect(resumed.manifest?.policyDecision?.kind).toBe("human_approved");
  });

  it("exhausts review repair budget and blocks the task", async () => {
    const root = await fixtureRepo();
    const config = {
      ...configFor(root),
      retries: {
        sdkStartupAttempts: 1,
        commandOrSpecRepairs: 0,
        reviewRepairs: 0,
        finalBranchRepairs: 0,
      },
    };
    const agent = createFakeAgentPort({
      runPlanner: async ({ intake }) => ({
        launch: { agentId: "p", runId: "p1", text: "{}" },
        intake: {
          ...intake,
          unresolvedQuestions: [],
          slices: [
            {
              id: "slice-1",
              title: "Review fail",
              summary: intake.idea,
              dependsOn: [],
              acceptanceCriteria: [
                { id: "ac-1", text: "Must satisfy this criterion fully" },
              ],
              allowedGlobs: ["src/**", "tests/**", "PASS"],
              testSeams: [],
              tddPolicy: "exempt_non_testable",
              tddExemptionReason: "fixture exemption",
            },
          ],
        },
      }),
      runImplementer: async ({ task, cwd }) => {
        await mkdir(path.join(cwd, "src"), { recursive: true });
        await writeFile(
          path.join(cwd, "src", `${task.id}.ts`),
          `export const x = 1;\n`,
          "utf8",
        );
        await writeFile(path.join(cwd, "PASS"), "1\n", "utf8");
        return {
          launch: { agentId: "w", runId: "w1", text: "{}" },
          report: {
            contractVersion: "1",
            taskId: task.id,
            summary: "ok",
            changedPaths: [`src/${task.id}.ts`, "PASS"],
            testsAddedOrUpdated: [],
            unresolvedRisks: [],
          },
        };
      },
      runSpecReview: async ({ task }) => ({
        launch: { agentId: "spec", runId: "s1", text: "{}" },
        report: {
          contractVersion: "1",
          taskId: task.id,
          acceptance: task.acceptanceCriteria.map((c) => ({
            criterionId: c.id,
            satisfied: false,
            evidence: "not done",
          })),
          findings: [
            {
              id: "f1",
              severity: "BLOCKING",
              criterionOrRule: "ac-1",
              location: "src",
              evidence: "missing",
              remediation: "implement",
            },
          ],
          browserProbeResults: [],
        },
      }),
    });

    const result = await runLifecycle({
      idea: "Force review budget exhaustion",
      runId: "budget-1",
      config,
      deps: { agent },
    });
    expect(["blocked", "partial", "failed", "paused"]).toContain(
      result.state.status,
    );
    expect(
      result.state.tasks.some(
        (t) =>
          t.status === "blocked" ||
          t.blockedReason === "MISSING_ACCEPTANCE" ||
          t.blockedReason === "REPAIR_BUDGET_EXHAUSTED" ||
          t.blockedReason === "BLOCKING_FINDING",
      ) || result.state.events.some((e) => e.type === "budget.exhausted"),
    ).toBe(true);
  });

  it("opens PR via github port after success", async () => {
    const root = await fixtureRepo();
    const github = createFakeGitHubPort([]);
    const agent = createFakeAgentPort({
      runPlanner: async ({ intake }) => ({
        launch: { agentId: "p", runId: "p1", text: "{}" },
        intake: {
          ...intake,
          unresolvedQuestions: [],
          slices: [
            {
              id: "slice-1",
              title: "Greet",
              summary: intake.idea,
              dependsOn: [],
              acceptanceCriteria: [
                { id: "ac-1", text: "Export greet returning hello" },
              ],
              allowedGlobs: ["src/**", "tests/**", "PASS"],
              testSeams: [],
              tddPolicy: "exempt_non_testable",
              tddExemptionReason: "fixture exemption",
            },
          ],
        },
      }),
      runImplementer: async ({ task, cwd }) => {
        await mkdir(path.join(cwd, "src"), { recursive: true });
        await writeFile(
          path.join(cwd, "src", `${task.id}.ts`),
          `export const greet = () => "hello";\n`,
          "utf8",
        );
        await writeFile(path.join(cwd, "PASS"), "1\n", "utf8");
        return {
          launch: { agentId: "w", runId: "w1", text: "{}" },
          report: {
            contractVersion: "1",
            taskId: task.id,
            summary: "ok",
            changedPaths: [`src/${task.id}.ts`, "PASS"],
            testsAddedOrUpdated: [],
            unresolvedRisks: [],
          },
        };
      },
    });

    const config = {
      ...configFor(root),
      github: {
        owner: "o",
        repo: "r",
        statusField: "Status",
        statusInProgress: "In Progress",
        statusDone: "Done",
        statusBlocked: "Blocked",
        afkLabel: "afk",
        hitlLabel: "hitl",
      },
    };

    // Fake github createPullRequest works; push to origin will fail without remote —
    // expect partial or succeeded without push. Wire a no-op by catching publish.
    const result = await runLifecycle({
      idea: "greet",
      runId: "pr-1",
      config,
      deps: { agent, github },
    });
    // Without a real origin, push fails → partial; still a valid publish path exercise.
    expect(["succeeded", "partial"]).toContain(result.state.status);
  });
});

describe("UI event replay", () => {
  it("serves state and replays SSE auth", async () => {
    const root = await fixtureRepo();
    const config = configFor(root);
    const agent = createFakeAgentPort({
      runPlanner: async ({ intake }) => ({
        launch: { agentId: "p", runId: "p1", text: "{}" },
        intake: {
          ...intake,
          unresolvedQuestions: [],
          slices: [
            {
              id: "slice-1",
              title: "UI",
              summary: intake.idea,
              dependsOn: [],
              acceptanceCriteria: [
                { id: "ac-1", text: "Create a tiny src file" },
              ],
              allowedGlobs: ["src/**", "PASS"],
              testSeams: [],
              tddPolicy: "exempt_non_testable",
              tddExemptionReason: "fixture exemption",
            },
          ],
        },
      }),
      runImplementer: async ({ task, cwd }) => {
        await mkdir(path.join(cwd, "src"), { recursive: true });
        await writeFile(path.join(cwd, "src", `${task.id}.ts`), "export {}\n", "utf8");
        await writeFile(path.join(cwd, "PASS"), "1\n", "utf8");
        return {
          launch: { agentId: "w", runId: "w1", text: "{}" },
          report: {
            contractVersion: "1",
            taskId: task.id,
            summary: "ok",
            changedPaths: [`src/${task.id}.ts`, "PASS"],
            testsAddedOrUpdated: [],
            unresolvedRisks: [],
          },
        };
      },
    });

    const ui = await startUiServer({
      config,
      agent,
      host: "127.0.0.1",
      port: 8799,
      token: "test-token",
    });

    try {
      const unauthorized = await fetch("http://127.0.0.1:8799/api/runs");
      expect(unauthorized.status).toBe(401);

      const created = await fetch(
        "http://127.0.0.1:8799/api/runs?token=test-token",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idea: "UI run" }),
        },
      );
      // Run start is asynchronous: the API acknowledges immediately and the
      // client observes progress via GET / SSE.
      expect(created.status).toBe(202);
      const body = (await created.json()) as { runId: string };
      expect(body.runId).toBeTruthy();

      let stateBody:
        | { state: { status: string; events: RunEvent[] }; error?: string }
        | undefined;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const stateRes = await fetch(
          `http://127.0.0.1:8799/api/runs/${body.runId}?token=test-token`,
        );
        if (stateRes.ok) {
          stateBody = (await stateRes.json()) as typeof stateBody;
          if (
            stateBody &&
            /succeeded|partial|blocked|paused|failed/.test(
              stateBody.state.status,
            )
          ) {
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(stateBody).toBeDefined();
      expect(stateBody!.state.events.length).toBeGreaterThan(0);
      expect(stateBody!.state.status).toMatch(/succeeded|partial|blocked|paused/);
    } finally {
      await ui.close();
    }
  });

  it("observes CLI-written run state via disk poll + list", async () => {
    const root = await fixtureRepo();
    const config = configFor(root);
    const runId = "cli-run-disk-poll";
    const directory = path.join(root, ".agent-harness", "runs", runId);
    await mkdir(directory, { recursive: true });

    const ui = await startUiServer({
      config,
      agent: createFakeAgentPort(),
      host: "127.0.0.1",
      port: 8798,
      token: "disk-token",
      pollIntervalMs: 100,
    });

    try {
      const emptyList = await fetch(
        "http://127.0.0.1:8798/api/runs?token=disk-token",
      );
      expect(emptyList.status).toBe(200);
      expect(((await emptyList.json()) as { runs: unknown[] }).runs).toEqual(
        [],
      );

      // Simulate prepare→approve→execute writing state outside the UI process.
      const {
        createInitialRunState,
        appendEvent,
        persistRunState,
        updateTaskState,
      } = await import("../../src/engine/state-machine.js");
      let state = createInitialRunState(runId);
      state = await appendEvent(directory, state, {
        type: "run.started",
        detail: { source: "cli-execute" },
      });
      state = updateTaskState(
        {
          ...state,
          status: "running",
          tasks: [
            {
              taskId: "t1",
              status: "pending",
              commandRepairsUsed: 0,
              reviewRepairsUsed: 0,
              sdkStartupRetriesUsed: 0,
              lastGateResults: [],
              tddEvidence: [],
              advisories: [],
            },
          ],
        },
        "t1",
        { status: "writing_tests" },
      );
      await persistRunState(directory, state);
      state = await appendEvent(directory, state, {
        type: "task.writing_tests",
        taskId: "t1",
      });

      const listed = await fetch(
        "http://127.0.0.1:8798/api/runs?token=disk-token",
      );
      const listedBody = (await listed.json()) as {
        runs: Array<{ runId: string; status: string }>;
      };
      expect(listedBody.runs.some((r) => r.runId === runId)).toBe(true);

      const got = await fetch(
        `http://127.0.0.1:8798/api/runs/${runId}?token=disk-token`,
      );
      expect(got.status).toBe(200);
      const body = (await got.json()) as {
        state: { status: string; tasks: Array<{ status: string }> };
      };
      expect(body.state.status).toBe("running");
      expect(body.state.tasks[0]?.status).toBe("writing_tests");

      // SSE client should receive a disk-poll catch-up (no in-process onEvent).
      const ac = new AbortController();
      const sseRes = await fetch(
        `http://127.0.0.1:8798/api/events?token=disk-token&runId=${runId}`,
        { signal: ac.signal, headers: { Accept: "text/event-stream" } },
      );
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get("content-type")).toMatch(/text\/event-stream/);
      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + 3000;
      let sawRunEvent = false;
      while (Date.now() < deadline && !sawRunEvent) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (const block of buf.split("\n\n")) {
          const line = block
            .split("\n")
            .find((l) => l.startsWith("data: "));
          if (!line) continue;
          const data = JSON.parse(line.slice(6)) as {
            detail?: { hello?: boolean };
            type?: string;
            runId?: string;
          };
          if (data.detail?.hello) continue;
          if (data.runId === runId || data.type) {
            sawRunEvent = true;
            break;
          }
        }
      }
      ac.abort();
      expect(sawRunEvent).toBe(true);
    } finally {
      await ui.close();
    }
  });
});

void readFile;

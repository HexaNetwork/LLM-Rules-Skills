import { describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadLocalSource } from "../../src/adapters/local.js";
import {
  createFakeGitHubPort,
  loadGitHubSource,
} from "../../src/adapters/github.js";
import { ProjectConfigSchema } from "../../src/schemas/config.js";
import {
  approveManifest,
  buildDraftManifest,
} from "../../src/engine/prepare.js";
import { executeRun } from "../../src/engine/orchestrator.js";
import { createFakeAgentPort } from "../../src/agents/cursor-sdk.js";
import { gitOk } from "../../src/util/git.js";

async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-harness-int-"));
  await gitOk(root, ["init"]);
  await gitOk(root, ["config", "user.email", "test@example.com"]);
  await gitOk(root, ["config", "user.name", "Test"]);
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: {
        typecheck: "node -e \"process.exit(0)\"",
        "test:run": "node -e \"process.exit(0)\"",
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
  });
}

describe("local + execute integration", () => {
  it("prepares, approves, and executes a successful AFK task", async () => {
    const root = await fixtureRepo();
    const bundle = path.join(root, "tasks.yaml");
    await writeFile(
      bundle,
      `tasks:
  - id: greet
    title: Add greet
    mode: AFK
    acceptanceCriteria:
      - id: ac-1
        text: Export greet returning hello
    allowedGlobs:
      - "src/**"
      - "tests/**"
`,
      "utf8",
    );

    const source = await loadLocalSource(bundle);
    const draft = await buildDraftManifest({
      config: configFor(root),
      source,
    });
    expect(draft.validationErrors).toEqual([]);
    const manifest = await approveManifest({
      draft,
      approvedBy: "tester",
    });

    const agent = createFakeAgentPort({
      runWorker: async ({ task, cwd }) => {
        await mkdir(path.join(cwd, "src"), { recursive: true });
        await writeFile(
          path.join(cwd, "src", `${task.id}.ts`),
          `export const greet = () => "hello";\n`,
          "utf8",
        );
        return {
          launch: { agentId: "w1", runId: "rw1", text: "{}" },
          report: {
            contractVersion: "1",
            taskId: task.id,
            summary: "ok",
            changedPaths: [`src/${task.id}.ts`],
            testsAddedOrUpdated: [],
            unresolvedRisks: [],
          },
        };
      },
    });

    const result = await executeRun({
      runId: "success-1",
      manifest,
      runRoot: path.join(root, ".agent-harness", "runs"),
      deps: { agent },
    });

    expect(result.state.status).toBe("succeeded");
    expect(result.state.tasks[0]?.status).toBe("accepted");
    expect(result.state.tasks[0]?.commitSha).toBeTruthy();
  });

  it("blocks dependents when an upstream task fails gates", async () => {
    const root = await fixtureRepo();
    const bundle = path.join(root, "tasks.yaml");
    await writeFile(
      bundle,
      `tasks:
  - id: a
    title: A
    mode: AFK
    acceptanceCriteria:
      - id: ac-1
        text: Implement A successfully
    allowedGlobs: ["src/**"]
  - id: b
    title: B
    mode: AFK
    blockedBy: [a]
    acceptanceCriteria:
      - id: ac-1
        text: Implement B successfully
    allowedGlobs: ["src/**"]
`,
      "utf8",
    );
    const source = await loadLocalSource(bundle);
    const draft = await buildDraftManifest({
      config: configFor(root),
      source,
    });
    const manifest = await approveManifest({ draft, approvedBy: "tester" });

    const agent = createFakeAgentPort({
      runWorker: async ({ task }) => ({
        launch: { agentId: "w", runId: "r", text: "{}" },
        report: {
          contractVersion: "1",
          taskId: task.id,
          summary: "touches protected",
          changedPaths: [".env"],
          testsAddedOrUpdated: [],
          unresolvedRisks: [],
        },
      }),
    });

    // Force path violation using report paths — also need dirty files.
    // Write .env so changedFiles sees it.
    const wrapping = createFakeAgentPort({
      runWorker: async ({ task, cwd }) => {
        await writeFile(path.join(cwd, ".env"), "SECRET=1\n", "utf8");
        return {
          launch: { agentId: "w", runId: "r", text: "{}" },
          report: {
            contractVersion: "1",
            taskId: task.id,
            summary: "bad",
            changedPaths: [".env"],
            testsAddedOrUpdated: [],
            unresolvedRisks: [],
          },
        };
      },
    });
    void agent;

    const result = await executeRun({
      runId: "blocked-1",
      manifest,
      runRoot: path.join(root, ".agent-harness", "runs"),
      deps: { agent: wrapping },
    });

    expect(result.state.tasks.find((t) => t.taskId === "a")?.status).toBe(
      "blocked",
    );
    expect(result.state.tasks.find((t) => t.taskId === "b")?.status).toBe(
      "blocked_dependency",
    );
  });
});

describe("github adapter", () => {
  it("normalizes nested issues into AFK tasks", async () => {
    const port = createFakeGitHubPort([
      {
        number: 1,
        id: 11,
        title: "Epic",
        body: "",
        labels: [],
        state: "open",
        htmlUrl: "https://example.com/1",
      },
      {
        number: 2,
        id: 22,
        title: "Task",
        body: "## Acceptance criteria\n- [ ] Users can sign in successfully\n",
        labels: ["afk"],
        state: "open",
        htmlUrl: "https://example.com/2",
        parentNumber: 1,
      },
    ]);
    const source = await loadGitHubSource({
      port,
      lifecycle: {
        owner: "o",
        repo: "r",
        statusField: "Status",
        statusInProgress: "In Progress",
        statusDone: "Done",
        statusBlocked: "Blocked",
        afkLabel: "afk",
        hitlLabel: "hitl",
      },
      entryIssueNumber: 1,
    });
    expect(source.tasks).toHaveLength(1);
    expect(source.tasks[0]?.id).toBe("gh-2");
    expect(source.tasks[0]?.mode).toBe("AFK");
    expect(source.tasks[0]?.acceptanceCriteria[0]?.text).toMatch(/sign in/);
  });
});

import path from "node:path";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ProjectConfigSchema } from "../schemas/config.js";
import { loadLocalSource } from "../adapters/local.js";
import { approveManifest, buildDraftManifest } from "../engine/prepare.js";
import { executeRun } from "../engine/orchestrator.js";
import { createFakeAgentPort } from "../agents/cursor-sdk.js";
import { gitOk } from "../util/git.js";

export type BenchmarkSummary = {
  runs: number;
  stable: boolean;
  statuses: string[];
  acceptedTaskCounts: number[];
  agentLaunchCounts: number[];
  blockedReasons: string[][];
};

export async function runBenchmark(repetitions = 3): Promise<BenchmarkSummary> {
  const statuses: string[] = [];
  const acceptedTaskCounts: number[] = [];
  const agentLaunchCounts: number[] = [];
  const blockedReasons: string[][] = [];

  for (let i = 0; i < repetitions; i += 1) {
    const root = await mkdtemp(path.join(tmpdir(), "agent-harness-bench-"));
    await gitOk(root, ["init"]);
    await gitOk(root, ["config", "user.email", "bench@example.com"]);
    await gitOk(root, ["config", "user.name", "Bench"]);
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

    const bundlePath = path.join(root, "tasks.yaml");
    await writeFile(
      bundlePath,
      `tasks:
  - id: t1
    title: Add greeting
    mode: AFK
    body: Add a greeting export
    acceptanceCriteria:
      - id: ac-1
        text: Export a greet function that returns hello
    allowedGlobs:
      - "src/**"
      - "tests/**"
`,
      "utf8",
    );

    const config = ProjectConfigSchema.parse({
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

    const source = await loadLocalSource(bundlePath);
    const draft = await buildDraftManifest({
      config,
      source,
      agent: createFakeAgentPort(),
      enrich: false,
    });
    const manifest = await approveManifest({
      draft,
      approvedBy: "benchmark",
    });

    // Fake worker writes the expected file so path/gates succeed
    const agent = createFakeAgentPort({
      runWorker: async ({ task }) => {
        await mkdir(path.join(root, "src"), { recursive: true });
        // Worker mutates the worktree; orchestrator passes worktree cwd.
        // For benchmark we mutate via report only and rely on fake changed paths.
        return {
          launch: {
            agentId: `w-${task.id}`,
            runId: `rw-${task.id}`,
            text: "{}",
          },
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

    // Patch: write files inside worker by wrapping execute with a custom agent
    // that uses the provided cwd.
    const writingAgent = createFakeAgentPort({
      runWorker: async ({ task, cwd }) => {
        await mkdir(path.join(cwd, "src"), { recursive: true });
        await writeFile(
          path.join(cwd, "src", `${task.id}.ts`),
          `export const greet = () => "hello";\n`,
          "utf8",
        );
        await mkdir(path.join(cwd, "tests"), { recursive: true });
        await writeFile(
          path.join(cwd, "tests", `${task.id}.test.ts`),
          `import { greet } from "../src/${task.id}.ts";\nif (greet() !== "hello") process.exit(1);\n`,
          "utf8",
        );
        return {
          launch: {
            agentId: `w-${task.id}`,
            runId: `rw-${task.id}`,
            text: "{}",
          },
          report: {
            contractVersion: "1",
            taskId: task.id,
            summary: "ok",
            changedPaths: [`src/${task.id}.ts`, `tests/${task.id}.test.ts`],
            testsAddedOrUpdated: [`tests/${task.id}.test.ts`],
            unresolvedRisks: [],
          },
        };
      },
    });
    void agent;

    const result = await executeRun({
      runId: `bench-${i}`,
      manifest,
      runRoot: path.join(root, ".agent-harness", "runs"),
      deps: { agent: writingAgent },
    });

    statuses.push(result.state.status);
    acceptedTaskCounts.push(
      result.state.tasks.filter((task) => task.status === "accepted").length,
    );
    agentLaunchCounts.push(result.state.cost.agentLaunches);
    blockedReasons.push(
      result.state.tasks
        .map((task) => task.blockedReason)
        .filter((reason): reason is NonNullable<typeof reason> =>
          Boolean(reason),
        ),
    );
  }

  const stable =
    new Set(statuses).size === 1 &&
    new Set(acceptedTaskCounts).size === 1 &&
    blockedReasons.every(
      (reasons) =>
        reasons.join("|") === (blockedReasons[0] ?? []).join("|"),
    );

  return {
    runs: repetitions,
    stable,
    statuses,
    acceptedTaskCounts,
    agentLaunchCounts,
    blockedReasons,
  };
}

#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { defaultConfigYaml, loadProjectConfig } from "./config/load.js";
import { loadLocalSource } from "./adapters/local.js";
import {
  createFakeGitHubPort,
  createGitHubApiPort,
  loadGitHubSource,
} from "./adapters/github.js";
import {
  approveManifest,
  buildDraftManifest,
} from "./engine/prepare.js";
import { executeRun } from "./engine/orchestrator.js";
import {
  createCursorAgentPort,
  createFakeAgentPort,
} from "./agents/cursor-sdk.js";
import { ensureDir, pathExists, readJson, writeJson } from "./util/fs.js";
import {
  DraftManifestSchema,
  RunManifestSchema,
} from "./schemas/manifest.js";
import { loadRunState } from "./engine/state-machine.js";
import { runBenchmark } from "./benchmark/repeatability.js";

const program = new Command();

program
  .name("agent-harness")
  .description(
    "Contract-deterministic Agent Harness for AFK implementation runs",
  )
  .version("0.1.0");

program
  .command("init")
  .description("Scaffold agent-harness.config.yaml in the current project")
  .option("--name <name>", "Project name", path.basename(process.cwd()))
  .option("--force", "Overwrite existing config", false)
  .action(async (options: { name: string; force: boolean }) => {
    const target = path.join(process.cwd(), "agent-harness.config.yaml");
    if ((await pathExists(target)) && !options.force) {
      throw new Error(`${target} already exists (use --force to overwrite)`);
    }
    await writeFile(target, defaultConfigYaml(options.name), "utf8");
    await ensureDir(path.join(process.cwd(), ".agent-harness", "runs"));
    console.log(`Wrote ${target}`);
  });

program
  .command("prepare")
  .description("Prepare a draft run manifest from local or GitHub sources")
  .option("--config <path>", "Path to project config")
  .option("--local <path>", "Local YAML/JSON task bundle")
  .option("--github <issue>", "GitHub issue number entry point")
  .option("--enrich", "Run prepare research agent", false)
  .option("--fake-agents", "Use fake agents (tests/dev)", false)
  .option("--out <path>", "Draft output path")
  .action(
    async (options: {
      config?: string;
      local?: string;
      github?: string;
      enrich?: boolean;
      fakeAgents?: boolean;
      out?: string;
    }) => {
      const { config } = await loadProjectConfig(options.config);
      if (!options.local && !options.github) {
        throw new Error("Provide --local <file> or --github <issueNumber>");
      }
      if (options.github && !config.github) {
        throw new Error("github section is required in config for --github");
      }
      const source = options.local
        ? await loadLocalSource(options.local)
        : await loadGitHubSource({
            port: createGitHubApiPort(),
            lifecycle: config.github!,
            entryIssueNumber: Number(options.github),
          });
      const agent = options.fakeAgents
        ? createFakeAgentPort()
        : createCursorAgentPort();
      const draft = await buildDraftManifest({
        config,
        source,
        agent,
        enrich: Boolean(options.enrich),
      });
      const out =
        options.out ??
        path.join(config.runDirectory, "drafts", `draft-${Date.now()}.json`);
      await writeJson(path.resolve(out), draft);
      console.log(`Draft written: ${path.resolve(out)}`);
      if (draft.validationErrors.length > 0) {
        console.error("Validation errors:");
        for (const error of draft.validationErrors) console.error(`- ${error}`);
        process.exitCode = 2;
      }
    },
  );

program
  .command("approve")
  .description("Approve a draft manifest into a frozen run manifest")
  .requiredOption("--draft <path>", "Draft manifest path")
  .option("--by <who>", "Approver identity", process.env.USER ?? "operator")
  .option("--out <path>", "Approved manifest output path")
  .action(async (options: { draft: string; by: string; out?: string }) => {
    const draft = DraftManifestSchema.parse(
      await readJson(path.resolve(options.draft)),
    );
    const approved = await approveManifest({
      draft,
      approvedBy: options.by,
    });
    const out =
      options.out ??
      path.join(
        path.dirname(path.resolve(options.draft)),
        `manifest-${approved.manifestHash.slice(0, 12)}.json`,
      );
    await writeJson(path.resolve(out), approved);
    console.log(`Approved manifest: ${path.resolve(out)}`);
    console.log(`manifestHash=${approved.manifestHash}`);
  });

program
  .command("execute")
  .description("Execute an approved run manifest")
  .requiredOption("--manifest <path>", "Approved manifest path")
  .option("--run-id <id>", "Run id")
  .option("--fake-agents", "Use fake agents", false)
  .option("--no-github", "Skip GitHub output adapter")
  .action(
    async (options: {
      manifest: string;
      runId?: string;
      fakeAgents?: boolean;
      github?: boolean;
    }) => {
      const manifest = RunManifestSchema.parse(
        await readJson(path.resolve(options.manifest)),
      );
      if (manifest.draft) {
        throw new Error("Refusing to execute a draft manifest; approve first");
      }
      const runId = options.runId ?? randomUUID();
      const runRoot = path.resolve(
        manifest.configSnapshot.repositoryRoot,
        manifest.configSnapshot.runDirectory,
      );
      const result = await executeRun({
        runId,
        manifest,
        runRoot,
        deps: {
          agent: options.fakeAgents
            ? createFakeAgentPort()
            : createCursorAgentPort(),
          github:
            options.github === false
              ? undefined
              : manifest.configSnapshot.github
                ? createGitHubApiPort()
                : undefined,
        },
      });
      console.log(`Run ${runId} finished: ${result.state.status}`);
      if (result.report.prUrl) console.log(`PR: ${result.report.prUrl}`);
      if (result.state.status !== "succeeded") process.exitCode = 3;
    },
  );

program
  .command("resume")
  .description("Resume a crashed or stopped run")
  .requiredOption("--run-id <id>", "Run id")
  .option("--config <path>", "Project config path")
  .option("--fake-agents", "Use fake agents", false)
  .action(
    async (options: {
      runId: string;
      config?: string;
      fakeAgents?: boolean;
    }) => {
      const { config } = await loadProjectConfig(options.config);
      const directory = path.resolve(
        config.repositoryRoot,
        config.runDirectory,
        options.runId,
      );
      const state = await loadRunState(directory);
      const manifest = RunManifestSchema.parse(
        await readJson(path.join(directory, "manifest.json")),
      );
      const result = await executeRun({
        runId: options.runId,
        manifest,
        runRoot: path.resolve(config.repositoryRoot, config.runDirectory),
        resumeState: state,
        deps: {
          agent: options.fakeAgents
            ? createFakeAgentPort()
            : createCursorAgentPort(),
          github: config.github ? createGitHubApiPort() : undefined,
        },
      });
      console.log(`Resumed run ${options.runId}: ${result.state.status}`);
      if (result.state.status !== "succeeded") process.exitCode = 3;
    },
  );

program
  .command("status")
  .description("Show run status")
  .requiredOption("--run-id <id>", "Run id")
  .option("--config <path>", "Project config path")
  .action(async (options: { runId: string; config?: string }) => {
    const { config } = await loadProjectConfig(options.config);
    const directory = path.resolve(
      config.repositoryRoot,
      config.runDirectory,
      options.runId,
    );
    const state = await loadRunState(directory);
    console.log(JSON.stringify(state, null, 2));
  });

program
  .command("benchmark")
  .description("Run contract-level repeatability benchmark on fixtures")
  .option("--runs <n>", "Repetitions", "3")
  .action(async (options: { runs: string }) => {
    const summary = await runBenchmark(Number(options.runs));
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.stable) process.exitCode = 4;
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

// silence unused import in case tree-shaking tools flag it
void createFakeGitHubPort;

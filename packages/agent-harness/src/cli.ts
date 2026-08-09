#!/usr/bin/env node
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { createCursorBackend } from "./agent.js";
import {
  defaultConfigYaml,
  deploymentConfigYaml,
  loadConfig,
  loadRunConfig,
  type HarnessConfig,
} from "./config.js";
import { HarnessEngine } from "./engine.js";
import { LocalKnowledgeBase } from "./knowledge.js";
import { startUiServer } from "./ui/server.js";

const program = new Command()
  .name("agent-harness")
  .description("Durable idea-to-feature orchestration with bounded, fresh agent sessions")
  .version("0.3.2");

program
  .command("init")
  .description("Create a v2 harness config and local artifact directory")
  .option("--force", "replace an existing config", false)
  .action(async (options: { force: boolean }) => {
    const target = path.join(process.cwd(), "agent-harness.config.yaml");
    if (!options.force && (await exists(target))) {
      throw new Error(`${target} already exists; use --force to replace it`);
    }
    await writeFile(target, defaultConfigYaml(), "utf8");
    await mkdir(path.join(process.cwd(), ".agent-harness"), { recursive: true });
    await ensureIgnored(path.join(process.cwd(), ".gitignore"), ".agent-harness/");
    await ensureIgnored(path.join(process.cwd(), ".gitignore"), "graphify-out/");
    await writeGraphifySetupScripts(process.cwd(), false);
    console.log(`Wrote ${target}`);
  });

program
  .command("deploy")
  .description("Install harness configuration and optional local RAG in another project")
  .requiredOption("--project <path>", "target project directory")
  .option("--force", "replace an existing config", false)
  .option("--sources <paths>", "comma-separated repository-relative source paths")
  .option("--ollama", "configure local Ollama semantic retrieval", false)
  .option("--model <name>", "Ollama embedding model", "qwen3-embedding")
  .option("--no-graphify", "advanced: disable structural code retrieval")
  .option("--install-graphify", "run the editable project-local Graphify setup script", false)
  .option("--install-graphify-prerequisite", "allow the setup script to install uv if needed", false)
  .option("--reset-graphify-scripts", "replace customized Graphify setup scripts with harness defaults", false)
  .option("--refresh", "build the first knowledge index", false)
  .action(async (options: {
    project: string;
    force: boolean;
    sources?: string;
    ollama: boolean;
    model: string;
    graphify: boolean;
    installGraphify: boolean;
    installGraphifyPrerequisite: boolean;
    resetGraphifyScripts: boolean;
    refresh: boolean;
  }) => {
    const project = path.resolve(options.project);
    const info = await stat(project);
    if (!info.isDirectory()) throw new Error(`${project} is not a directory`);
    const target = path.join(project, "agent-harness.config.yaml");
    if (!options.force && (await exists(target))) {
      throw new Error(`${target} already exists; use --force to replace it`);
    }
    const sources = options.sources
      ? options.sources.split(",").map((source) => source.trim()).filter(Boolean)
      : await discoverDeploymentSources(project);
    await writeFile(target, deploymentConfigYaml({
      sources,
      ollama: options.ollama,
      model: options.model,
      graphify: options.graphify,
    }), "utf8");
    await mkdir(path.join(project, ".agent-harness"), { recursive: true });
    await ensureIgnored(path.join(project, ".gitignore"), ".agent-harness/");
    await ensureIgnored(path.join(project, ".gitignore"), "graphify-out/");
    const graphifyScripts = await writeGraphifySetupScripts(project, options.resetGraphifyScripts);
    console.log(`Deployed harness config to ${target}`);
    console.log(`Knowledge sources: ${sources.join(", ") || "none"}`);
    if (options.ollama) console.log(`Semantic retrieval: Ollama / ${options.model}`);
    console.log(
      options.graphify
        ? "Repository structure: Graphify (prepared before new runs and rebuilt after task commits)"
        : "Repository structure: Graphify disabled (--no-graphify)",
    );
    console.log(`Editable Graphify setup scripts: ${graphifyScripts}`);
    if (options.installGraphify) {
      await runGraphifySetupScript(project, options.installGraphifyPrerequisite);
    }
    if (options.refresh) {
      const { config } = await loadConfig(target);
      const changed = await new LocalKnowledgeBase(config).refresh();
      console.log(`Indexed ${changed} changed document(s)`);
    }
    await warnIfDeployedFilesUntracked(project, [
      target,
      path.join(graphifyScripts, "setup-graphify.ps1"),
      path.join(graphifyScripts, "setup-graphify.sh"),
    ]);
  });

const graphify = program
  .command("graphify")
  .description("Manage the editable project-local Graphify setup scripts");

graphify
  .command("scripts")
  .description("create missing setup scripts, or reset customized scripts to harness defaults")
  .requiredOption("--project <path>", "target project directory")
  .option("--reset", "replace customized scripts with harness defaults", false)
  .action(async (options: { project: string; reset: boolean }) => {
    const project = path.resolve(options.project);
    const info = await stat(project);
    if (!info.isDirectory()) throw new Error(`${project} is not a directory`);
    const directory = await writeGraphifySetupScripts(project, options.reset);
    console.log(`${options.reset ? "Reset" : "Prepared"} Graphify setup scripts in ${directory}`);
  });

graphify
  .command("install")
  .description("run the project's editable Graphify setup script")
  .requiredOption("--project <path>", "target project directory")
  .option("--install-prerequisite", "allow the script to install uv if needed", false)
  .action(async (options: { project: string; installPrerequisite: boolean }) => {
    const project = path.resolve(options.project);
    const info = await stat(project);
    if (!info.isDirectory()) throw new Error(`${project} is not a directory`);
    await writeGraphifySetupScripts(project, false);
    await runGraphifySetupScript(project, options.installPrerequisite);
  });

program
  .command("start")
  .alias("run")
  .description("Start a durable run from one idea")
  .requiredOption("--idea <textOrAtFile>", "idea text, or @path")
  .option("--run-id <id>", "stable run id")
  .option("--config <path>", "config path")
  .option("--tdd <mode>", "override TDD for this run: on or off")
  .option("--no-advance", "create artifacts without launching agents")
  .action(
    async (options: {
      idea: string;
      runId?: string;
      config?: string;
      tdd?: string;
      advance: boolean;
    }) => {
      const config = await resolvedConfig(options.config, options.tdd);
      const engine = new HarnessEngine(config, { backend: createCursorBackend() });
      const idea = options.idea.startsWith("@")
        ? await readFile(path.resolve(options.idea.slice(1)), "utf8")
        : options.idea;
      let state = await engine.start(idea, options.runId ?? randomUUID());
      if (options.advance) state = await engine.advance(state.runId);
      printState(state);
    },
  );

program
  .command("continue")
  .description("Advance a run from its persisted artifacts")
  .requiredOption("--run-id <id>", "run id")
  .option("--config <path>", "config path")
  .option("--steps <count>", "maximum transitions before yielding")
  .action(async (options: { runId: string; config?: string; steps?: string }) => {
    const config = await runConfig(options.config, options.runId);
    const engine = new HarnessEngine(config, { backend: createCursorBackend() });
    const state = await engine.advance(
      options.runId,
      options.steps ? positiveInteger(options.steps, "steps") : undefined,
    );
    printState(state);
  });

program
  .command("answer")
  .description("Answer one persisted HITL question, then continue")
  .requiredOption("--run-id <id>", "run id")
  .requiredOption("--question <id>", "question id")
  .requiredOption("--text <answer>", "answer text")
  .option("--config <path>", "config path")
  .option("--no-advance", "record the answer without launching agents")
  .action(
    async (options: {
      runId: string;
      question: string;
      text: string;
      config?: string;
      advance: boolean;
    }) => {
      const config = await runConfig(options.config, options.runId);
      const engine = new HarnessEngine(config, { backend: createCursorBackend() });
      let state = await engine.answer(options.runId, options.question, options.text);
      if (options.advance) state = await engine.advance(options.runId);
      printState(state);
    },
  );

program
  .command("retry")
  .description("Explicitly retry a bounded step after inspecting a blocked run")
  .requiredOption("--run-id <id>", "run id")
  .option("--config <path>", "config path")
  .option("--force", "retry even when blockedRetriable is false", false)
  .option(
    "--max-run-tokens <n>",
    "raise the frozen run's maxRunTokens ceiling (requires --force for budget blocks)",
    (value) => Number(value),
  )
  .option(
    "--max-run-cost-usd <n>",
    "raise the frozen run's maxRunCostUsd ceiling (requires --force for budget blocks)",
    (value) => Number(value),
  )
  .option(
    "--commit-dirty [order]",
    "commit a dirty working tree before retrying: branch-then-commit (default) or commit-then-branch",
  )
  .option(
    "--accept-tree",
    "accept the current working tree after a divergence block (re-stamp fingerprint and retry)",
    false,
  )
  .action(async (options: {
    runId: string;
    config?: string;
    force: boolean;
    maxRunTokens?: number;
    maxRunCostUsd?: number;
    commitDirty?: string | boolean;
    acceptTree: boolean;
  }) => {
    const config = await runConfig(options.config, options.runId);
    const engine = new HarnessEngine(config, { backend: createCursorBackend() });
    if (options.maxRunTokens != null && (!Number.isFinite(options.maxRunTokens) || options.maxRunTokens < 0)) {
      throw new Error("--max-run-tokens must be a non-negative number");
    }
    if (options.maxRunCostUsd != null && (!Number.isFinite(options.maxRunCostUsd) || options.maxRunCostUsd < 0)) {
      throw new Error("--max-run-cost-usd must be a non-negative number");
    }
    if (options.acceptTree && options.commitDirty) {
      throw new Error("--accept-tree and --commit-dirty cannot be used together");
    }
    if (options.acceptTree) {
      await engine.acceptTree(options.runId);
    } else if (options.commitDirty) {
      const order = typeof options.commitDirty === "string" ? options.commitDirty : undefined;
      if (order != null && order !== "branch-then-commit" && order !== "commit-then-branch") {
        throw new Error("--commit-dirty must be branch-then-commit or commit-then-branch");
      }
      await engine.commitPreflight(options.runId, { order });
    } else {
      await engine.retry(options.runId, {
        force: options.force,
        maxRunTokens: options.maxRunTokens,
        maxRunCostUsd: options.maxRunCostUsd,
      });
    }
    printState(await engine.advance(options.runId));
  });

program
  .command("status")
  .description("Show persisted run state")
  .requiredOption("--run-id <id>", "run id")
  .option("--config <path>", "config path")
  .option("--json", "print the full state", false)
  .action(async (options: { runId: string; config?: string; json: boolean }) => {
    const config = await runConfig(options.config, options.runId);
    const engine = new HarnessEngine(config, { backend: createCursorBackend("unused") });
    const state = await engine.status(options.runId);
    if (options.json) {
      const usage = await aggregateSessionUsage(engine, options.runId);
      console.log(JSON.stringify({ ...state, usage }, null, 2));
      return;
    }
    printState(state);
  });

program
  .command("cancel")
  .description("Mark a run cancelled; no process is left waiting")
  .requiredOption("--run-id <id>", "run id")
  .option("--config <path>", "config path")
  .action(async (options: { runId: string; config?: string }) => {
    const config = await runConfig(options.config, options.runId);
    const engine = new HarnessEngine(config, { backend: createCursorBackend("unused") });
    const result = await engine.cancel(options.runId);
    if (result.pending) {
      console.log(`Cancellation pending for ${options.runId}; the advancing process will finish it.`);
    }
    printState(result.state);
  });

program
  .command("unlock")
  .description("Force-remove a stale run lock, and optionally the repository lock")
  .requiredOption("--run-id <id>", "run id")
  .option("--repo", "also remove the repository lock when present", false)
  .option("--config <path>", "config path")
  .action(async (options: { runId: string; repo: boolean; config?: string }) => {
    const config = await runConfig(options.config, options.runId);
    const engine = new HarnessEngine(config, { backend: createCursorBackend("unused") });
    const store = engine.store;
    const runLock = await store.inspectRunLock(options.runId);
    if (runLock) {
      printLockRemoval("run", runLock);
    } else {
      console.log(`No run lock found for ${options.runId}.`);
    }
    let repoLock: Awaited<ReturnType<typeof store.inspectRepositoryLock>> | undefined;
    if (options.repo) {
      repoLock = await store.inspectRepositoryLock();
      if (repoLock) {
        printLockRemoval("repository", repoLock);
      } else {
        console.log("Repository lock not present.");
      }
    }
    const result = await store.unlock(options.runId, { repo: options.repo });
    if (result.run && runLock) console.log(`Removed run lock: ${runLock.path}`);
    if (options.repo && result.repo === true && repoLock) {
      console.log(`Removed repository lock: ${repoLock.path}`);
    }
  });

program
  .command("ui")
  .description("Open the centralized loopback dashboard")
  .option("--config <path>", "config path")
  .option("--port <number>", "loopback port", "8787")
  .option("--no-open", "do not open the browser automatically")
  .action(async (options: { config?: string; port: string; open: boolean }) => {
    const loaded = await loadConfig(options.config);
    const ui = await startUiServer({
      config: loaded.config,
      configPath: loaded.path,
      backend: createCursorBackend(),
      port: positiveInteger(options.port, "port"),
      openBrowser: options.open,
    });
    console.log(`Agent Harness UI: ${ui.url}`);
    console.log("Loopback only. Press Ctrl+C to stop.");
    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        void ui.close().finally(resolve);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  });

const knowledge = program.command("knowledge").description("Manage local lexical and Graphify retrieval");

knowledge
  .command("refresh")
  .option("--config <path>", "config path")
  .action(async (options: { config?: string }) => {
    const { config } = await loadConfig(options.config);
    const count = await new LocalKnowledgeBase(config).refresh();
    console.log(`Indexed ${count} changed document(s)`);
  });

knowledge
  .command("add")
  .argument("<path>", "local text file")
  .option("--config <path>", "config path")
  .action(async (file: string, options: { config?: string }) => {
    const { config } = await loadConfig(options.config);
    const base = new LocalKnowledgeBase(config);
    const changed = await base.upsertFile(path.resolve(config.repositoryRoot, file));
    console.log(changed ? "Indexed document" : "Document unchanged or unsupported");
  });

knowledge
  .command("search")
  .argument("<query>", "search terms")
  .option("--limit <count>", "maximum results", "6")
  .option("--project <id>", "active project id; defaults to knowledge.projectId")
  .option(
    "--include-project <ids>",
    "comma-separated shared project ids to search explicitly",
  )
  .option("--max-characters <count>", "cap returned context characters")
  .option("--config <path>", "config path")
  .action(async (query: string, options: {
    limit: string;
    project?: string;
    includeProject?: string;
    maxCharacters?: string;
    config?: string;
  }) => {
    const { config } = await loadConfig(options.config);
    const results = await new LocalKnowledgeBase(config).search(
      query,
      positiveInteger(options.limit, "limit"),
      {
        projectId: options.project,
        includeProjects: splitProjectIds(options.includeProject),
        maxCharacters: options.maxCharacters
          ? positiveInteger(options.maxCharacters, "max-characters")
          : undefined,
      },
    );
    console.log(JSON.stringify(results, null, 2));
  });

async function discoverDeploymentSources(project: string): Promise<string[]> {
  const candidates = [
    "README.md",
    "GLOSSARY.md",
    "docs",
    "documentation",
    "architecture",
    "adr",
  ];
  const found: string[] = [];
  for (const candidate of candidates) {
    if (await exists(path.join(project, candidate))) found.push(candidate);
  }
  // Preserve the familiar minimal defaults when no conventional source root is
  // present; refresh safely skips paths that have not been created yet.
  return found.length > 0 ? found : ["README.md", "docs"];
}

async function resolvedConfig(configPath: string | undefined, tdd: string | undefined): Promise<HarnessConfig> {
  const { config } = await loadConfig(configPath);
  if (tdd == null) return config;
  if (tdd !== "on" && tdd !== "off") throw new Error("--tdd must be 'on' or 'off'");
  return { ...config, workflow: { ...config.workflow, tdd: tdd === "on" } };
}

async function runConfig(configPath: string | undefined, runId: string): Promise<HarnessConfig> {
  const { config } = await loadConfig(configPath);
  return loadRunConfig(config, runId);
}

async function aggregateSessionUsage(
  engine: HarnessEngine,
  runId: string,
): Promise<{
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  sessions: number;
}> {
  const files = (await engine.store.listFiles(runId, "sessions")).filter((file) =>
    file.endsWith(".json"),
  );
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  for (const file of files) {
    const session = (await engine.store.readJson(runId, file)) as {
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    };
    const usage = session.usage ?? {};
    inputTokens += Number(usage.inputTokens ?? 0);
    outputTokens += Number(usage.outputTokens ?? 0);
    totalTokens +=
      typeof usage.totalTokens === "number"
        ? usage.totalTokens
        : Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0);
  }
  return { inputTokens, outputTokens, totalTokens, sessions: files.length };
}

function printLockRemoval(
  kind: "run" | "repository",
  info: { path: string; body: { pid: number; hostname: string; at: string } | null; ageMs: number | null },
): void {
  const ageSeconds = info.ageMs == null ? "unknown" : `${Math.round(info.ageMs / 1000)}s`;
  if (info.body) {
    console.log(
      `Breaking ${kind} lock: pid=${info.body.pid} hostname=${info.body.hostname} at=${info.body.at} age=${ageSeconds}`,
    );
  } else {
    console.log(`Breaking ${kind} lock (unparseable body, age=${ageSeconds}): ${info.path}`);
  }
}

function printState(state: Awaited<ReturnType<HarnessEngine["status"]>>): void {
  console.log(`Run ${state.runId}: ${state.phase}`);
  console.log(`Artifacts: ${state.runId}/state.json (under the configured state directory)`);
  const question = state.questions.find((item) => item.id === state.activeQuestionId);
  if (question) {
    console.log(`Question ${question.id}: ${question.prompt}`);
    if (question.context) console.log(`Why this matters: ${question.context}`);
    for (const option of question.options) {
      const recommended = option.id === question.recommendedOptionId ? " (recommended)" : "";
      console.log(`- ${option.label}${recommended}: ${option.description}`);
    }
    if (question.recommendation) {
      console.log(`Recommendation: ${question.recommendation}`);
    }
    console.log(`Answer with: agent-harness answer --run-id ${state.runId} --question ${question.id} --text "..."`);
  }
  if (state.failure) console.log(`Blocked: ${state.failure}`);
  if (state.pullRequestUrl) console.log(`Pull request: ${state.pullRequestUrl}`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureIgnored(filePath: string, entry: string): Promise<void> {
  const current = (await exists(filePath)) ? await readFile(filePath, "utf8") : "";
  if (current.split(/\r?\n/).includes(entry)) return;
  const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await writeFile(filePath, `${current}${separator}${entry}\n`, "utf8");
}

const execFileAsync = promisify(execFile);

/**
 * Deploy leaves committable files (config + scripts, see writeGraphifySetupScripts)
 * untracked; a run refuses to start on a dirty tree, so surface that now, not later.
 */
async function warnIfDeployedFilesUntracked(project: string, absolutePaths: string[]): Promise<void> {
  if (!(await isGitRepository(project))) return;
  const relativePaths = absolutePaths.map((absolute) => path.relative(project, absolute));
  const untracked = await gitUntrackedPaths(project, relativePaths);
  if (untracked.length === 0) return;
  console.log("");
  console.log("Deployed files are untracked in this git repository:");
  for (const file of untracked) console.log(`  ${file}`);
  console.log("Runs will refuse to start until the working tree is clean.");
  console.log(`Commit them: git add ${untracked.map((file) => `"${file}"`).join(" ")} && git commit -m "chore: deploy agent-harness"`);
  console.log(
    "Alternative: set git.autoCommitPreflight: true in the config so a dirty tree is committed automatically instead of blocking new runs.",
  );
}

async function isGitRepository(project: string): Promise<boolean> {
  try {
    const result = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: project,
      windowsHide: true,
    });
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function gitUntrackedPaths(project: string, relativePaths: string[]): Promise<string[]> {
  try {
    const result = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all", "--", ...relativePaths],
      { cwd: project, windowsHide: true },
    );
    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).trim());
  } catch {
    return [];
  }
}

const GRAPHIFY_SETUP_FILENAMES = ["setup-graphify.ps1", "setup-graphify.sh"] as const;

/**
 * Setup scripts deliberately live in the deployed project, not hidden harness
 * state. Teams can review and customize them; reset is explicit and never
 * overwrites a local edit during ordinary deployment.
 */
async function writeGraphifySetupScripts(project: string, reset: boolean): Promise<string> {
  const destination = path.join(project, "agent-harness", "scripts");
  const templateDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../templates/graphify",
  );
  await mkdir(destination, { recursive: true });
  for (const filename of GRAPHIFY_SETUP_FILENAMES) {
    const target = path.join(destination, filename);
    if (!reset && (await exists(target))) continue;
    const template = await readFile(path.join(templateDirectory, filename), "utf8");
    await writeFile(target, template, "utf8");
  }
  return destination;
}

async function runGraphifySetupScript(project: string, installPrerequisite: boolean): Promise<void> {
  const scripts = await writeGraphifySetupScripts(project, false);
  const isWindows = process.platform === "win32";
  const executable = isWindows ? "powershell.exe" : "bash";
  const scriptPath = path.join(scripts, isWindows ? "setup-graphify.ps1" : "setup-graphify.sh");
  const args = isWindows
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-ProjectRoot", project]
    : [scriptPath, "--project-root", project];
  if (installPrerequisite) {
    args.push(isWindows ? "-InstallUv" : "--install-uv");
  }
  console.log(`Running ${scriptPath}`);
  await new Promise<void>((resolve, reject) => {
    execFile(executable, args, { cwd: project, windowsHide: true }, (error, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (error) reject(error);
      else resolve();
    });
  });
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function splitProjectIds(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((id) => id.trim()).filter(Boolean);
}

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

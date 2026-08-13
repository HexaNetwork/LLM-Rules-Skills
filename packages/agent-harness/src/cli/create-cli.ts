import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { createCursorBackend } from "../infrastructure/agents/cursor-backend.js";
import type { AgentBackend } from "../infrastructure/agents/types.js";
import { defaultConfigYaml, deploymentConfigYaml } from "../config/defaults.js";
import { loadConfig, loadRunConfig } from "../config/io.js";
import type { HarnessConfig } from "../config/schema.js";
import {
  loadExternalProjectConfig,
  seedExternalGuidance,
} from "../application/external-config.js";
import { resolveHarnessHome, HARNESS_HOME_ENV } from "../application/harness-home.js";
import { ProjectRegistry } from "../application/project-registry.js";
import { formatBytes, reportProjectStorage } from "../application/storage-report.js";
import { openRunHarness } from "../application/run-engine-factory.js";
import { HarnessEngine } from "../application/harness-engine.js";
import { GitService } from "../git.js";
import { LocalKnowledgeBase } from "../knowledge.js";
import { startUiServer, type UiServer } from "../ui/server.js";

export type CliDependencies = {
  createBackend: (apiKey?: string) => AgentBackend;
  startUiServer: (options: Parameters<typeof startUiServer>[0]) => Promise<UiServer>;
};

export function productionCliDependencies(): CliDependencies {
  return {
    createBackend: (apiKey) => createCursorBackend(apiKey),
    startUiServer,
  };
}

export function createCli(dependencies: CliDependencies = productionCliDependencies()): Command {
  const program = new Command()
    .name("agent-harness")
    .description("Durable idea-to-feature orchestration with bounded, fresh agent sessions")
    .version("0.3.2")
    // Let callers (main / acceptance tests) observe parse errors instead of
    // process.exit, which would tear down the Vitest worker mid-suite.
    .exitOverride();

  program
    .command("init")
    .description("Create a v2 harness config and local artifact directory")
    .option("--force", "replace an existing config", false)
    .action(async (options: { force: boolean }) => {
      const project = process.cwd();
      const target = path.join(project, "agent-harness.config.yaml");
      if (!options.force && (await exists(target))) {
        throw new Error(`${target} already exists; use --force to replace it`);
      }
      await writeFile(target, defaultConfigYaml(), "utf8");
      await mkdir(path.join(project, ".agent-harness"), { recursive: true });
      await ensureIgnored(path.join(project, ".gitignore"), ".agent-harness/");
      await ensureIgnored(path.join(project, ".gitignore"), ".gitnexus/");
      await ensureIgnored(path.join(project, ".gitignore"), ".codegraph/");
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
    .option("--no-repository-intelligence", "advanced: disable structural repository retrieval")
    .option("--refresh", "build the first knowledge index", false)
    .action(async (options: {
      project: string;
      force: boolean;
      sources?: string;
      ollama: boolean;
      model: string;
      repositoryIntelligence: boolean;
      refresh: boolean;
    }) => {
      const project = path.resolve(options.project);
      const info = await stat(project);
      if (!info.isDirectory()) throw new Error(`${project} is not a directory`);
      const target = path.join(project, "agent-harness.config.yaml");
      if (!options.force && (await exists(target))) {
        throw new Error(`${target} already exists; use --force to replace it`);
      }
      const projectSources = options.sources
        ? options.sources.split(",").map((source) => source.trim()).filter(Boolean)
        : await discoverDeploymentSources(project);
      const sources = projectSources.map((sourcePath) => ({
        path: sourcePath,
        scope: "project" as const,
        visibility: "private" as const,
      }));
      await writeFile(target, deploymentConfigYaml({
        sources,
        ollama: options.ollama,
        model: options.model,
        repositoryIntelligence: options.repositoryIntelligence,
      }), "utf8");
      await mkdir(path.join(project, ".agent-harness"), { recursive: true });
      await ensureIgnored(path.join(project, ".gitignore"), ".agent-harness/");
      await ensureIgnored(path.join(project, ".gitignore"), ".gitnexus/");
      await ensureIgnored(path.join(project, ".gitignore"), ".codegraph/");
      console.log(`Deployed harness config to ${target}`);
      console.log(
        `Knowledge sources: ${sources.map((source) => `${source.path} (${source.scope})`).join(", ") || "none"}`,
      );
      if (options.ollama) console.log(`Semantic retrieval: Ollama / ${options.model}`);
      console.log(
        options.repositoryIntelligence
          ? "Repository intelligence: enabled (ordered provider routes; indexes prepared before new runs and after task commits)"
          : "Repository intelligence: disabled (--no-repository-intelligence)",
      );
      if (options.refresh) {
        const { config } = await loadConfig(target);
        const changed = await new LocalKnowledgeBase(config).refresh();
        console.log(`Indexed ${changed} changed document(s)`);
      }
      await warnIfNotGitRepository(project);
      await warnIfDeployedFilesUntracked(project, [
        target,
        path.join(project, ".gitignore"),
      ]);
    });

  const projectCmd = program
    .command("project")
    .description("Manage external harness project registrations (zero-footprint targets)");

  projectCmd
    .command("add")
    .description("Register a repository in the external harness home (no repo-local files)")
    .requiredOption("--repository <path>", "target repository path")
    .option("--name <name>", "display name")
    .option("--worktree-root <path>", "override sibling worktree root")
    .option("--home <path>", "harness home override")
    .action(async (options: {
      repository: string;
      name?: string;
      worktreeRoot?: string;
      home?: string;
    }) => {
      const home = resolveHarnessHome({ homeRoot: options.home });
      const registry = new ProjectRegistry(home);
      const guidance = await seedExternalGuidance(home);
      const lookup = await registry.add({
        repository: options.repository,
        name: options.name,
        worktreeRoot: options.worktreeRoot,
        home,
      });
      // Write initial external project config without touching the repository.
      await loadExternalProjectConfig({
        projectKey: lookup.registration.projectKey,
        home,
      });
      console.log(`Registered project ${lookup.registration.projectKey}`);
      console.log(`  displayName: ${lookup.registration.displayName}`);
      console.log(`  controlRoot: ${lookup.paths.controlRoot}`);
      console.log(`  stateRoot: ${lookup.paths.projectStateRoot}`);
      console.log(`  worktreeRoot: ${lookup.paths.worktreeRoot}`);
      console.log(`  config: ${lookup.paths.projectConfigPath}`);
      console.log(
        `  guidance: ${guidance.sourcePath}${guidance.copied ? " (seeded)" : " (reused)"}`,
      );
      console.log(`  home: ${home.homeRoot} (override with ${HARNESS_HOME_ENV} or --home)`);
    });

  projectCmd
    .command("list")
    .description("List registered projects")
    .option("--home <path>", "harness home override")
    .action(async (options: { home?: string }) => {
      const home = resolveHarnessHome({ homeRoot: options.home });
      const registrations = await new ProjectRegistry(home).list();
      if (registrations.length === 0) {
        console.log("No registered projects.");
        return;
      }
      for (const registration of registrations) {
        console.log(
          `${registration.projectKey}\t${registration.displayName}\t${registration.controlRoot}`,
        );
      }
    });

  projectCmd
    .command("validate")
    .description("Validate a project registration and Git identity")
    .requiredOption("--project <project-key>", "project key")
    .option("--home <path>", "harness home override")
    .action(async (options: { project: string; home?: string }) => {
      const home = resolveHarnessHome({ homeRoot: options.home });
      const result = await new ProjectRegistry(home).validate(options.project);
      if (result.ok) {
        console.log(`Project ${options.project} is valid.`);
        return;
      }
      console.log(`Project ${options.project} has issues:`);
      for (const issue of result.issues) console.log(`  - ${issue}`);
      throw new Error("Project validation failed");
    });

  projectCmd
    .command("relink")
    .description("Update a registration after the repository moved")
    .requiredOption("--project <project-key>", "project key")
    .requiredOption("--repository <path>", "new repository path")
    .option("--home <path>", "harness home override")
    .action(async (options: { project: string; repository: string; home?: string }) => {
      const home = resolveHarnessHome({ homeRoot: options.home });
      const lookup = await new ProjectRegistry(home).relink({
        projectKey: options.project,
        repository: options.repository,
        home,
      });
      console.log(
        `Relinked ${lookup.registration.projectKey} → ${lookup.registration.controlRoot}`,
      );
    });

  projectCmd
    .command("remove")
    .description("Remove a project registration (never deletes the target repository)")
    .requiredOption("--project <project-key>", "project key")
    .option("--force", "remove even when unsettled runs remain", false)
    .option("--home <path>", "harness home override")
    .action(async (options: { project: string; force: boolean; home?: string }) => {
      const home = resolveHarnessHome({ homeRoot: options.home });
      const registry = new ProjectRegistry(home);
      const before = await registry.get(options.project);
      const report = await reportProjectStorage(before.paths);
      console.log(`Storage before removal (${formatBytes(report.totalBytes)}):`);
      for (const category of report.categories) {
        console.log(
          `  ${category.category}: ${formatBytes(category.bytes)} (${category.entries} entries) @ ${category.path}`,
        );
      }
      const removed = await registry.remove(options.project, { force: options.force });
      console.log(`Removed registration ${removed.projectKey} (${removed.displayName}).`);
      console.log(`Target repository left untouched: ${removed.controlRoot}`);
    });

  program
    .command("storage")
    .description("Report external storage usage for a registered project")
    .option("--project <project-key>", "project key")
    .option("--repository <path>", "repository path")
    .option("--home <path>", "harness home override")
    .action(async (options: { project?: string; repository?: string; home?: string }) => {
      const home = resolveHarnessHome({ homeRoot: options.home });
      const lookup = await new ProjectRegistry(home).discover({
        projectKey: options.project,
        repository: options.repository,
      });
      const report = await reportProjectStorage(lookup.paths);
      console.log(`Project ${report.projectKey}`);
      console.log(`  controlRoot: ${report.controlRoot}`);
      console.log(`  worktreeRoot: ${report.worktreeRoot}`);
      console.log(`  stateRoot: ${report.projectStateRoot}`);
      console.log(`  total: ${formatBytes(report.totalBytes)}`);
      for (const category of report.categories) {
        console.log(
          `  ${category.category}: ${formatBytes(category.bytes)} (${category.entries} entries)`,
        );
      }
    });

  program
    .command("start")
    .alias("run")
    .description("Start a durable run from one idea")
    .requiredOption("--idea <textOrAtFile>", "idea text, or @path")
    .option("--run-id <id>", "stable run id")
    .option("--config <path>", "explicit config path override")
    .option("--project <project-key>", "external project key")
    .option("--repository <path>", "registered repository path")
    .option("--home <path>", "harness home override")
    .option("--rag <mode>", "override document RAG for this run: on or off")
    .option("--base-branch <name>", "override local base branch for this run")
    .option("--no-advance", "create artifacts without launching agents")
    .action(
      async (options: {
        idea: string;
        runId?: string;
        config?: string;
        project?: string;
        repository?: string;
        home?: string;
        rag?: string;
        baseBranch?: string;
        advance: boolean;
      }) => {
        const resolved = await resolvedProjectConfig(options);
        const config = await applyRunOverrides(
          resolved.config,
          options.baseBranch,
          options.rag,
        );
        const engine = new HarnessEngine(config, {
          backend: dependencies.createBackend(),
          ...(resolved.lookup
            ? {
                projectContext: {
                  home: resolved.lookup.home,
                  paths: resolved.lookup.paths,
                },
                paths: {
                  controlRoot: resolved.lookup.paths.controlRoot,
                  stateRoot: resolved.lookup.paths.projectStateRoot,
                  workspaceRoot: resolved.lookup.paths.controlRoot,
                  worktreeRoot: resolved.lookup.paths.worktreeRoot,
                },
              }
            : {}),
        });
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
    .action(async (options: { runId: string; config?: string }) => {
      const engine = await openRunEngine(options.config, options.runId, dependencies.createBackend);
      const state = await engine.advance(options.runId);
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
        const engine = await openRunEngine(
          options.config,
          options.runId,
          dependencies.createBackend,
        );
        let state = await engine.answer(options.runId, options.question, options.text);
        if (options.advance) state = await engine.advance(options.runId);
        printState(state);
      },
    );

  program
    .command("confirm-grill")
    .description("Continue to planning after grilling, or reopen with feedback")
    .requiredOption("--run-id <id>", "run id")
    .option("--feedback <text>", "non-empty feedback reopens the griller")
    .option("--config <path>", "config path")
    .option("--no-advance", "confirm without launching the next agents")
    .action(
      async (options: {
        runId: string;
        feedback?: string;
        config?: string;
        advance: boolean;
      }) => {
        const engine = await openRunEngine(
          options.config,
          options.runId,
          dependencies.createBackend,
        );
        let state = await engine.confirmGrill(options.runId, { feedback: options.feedback });
        if (options.advance) state = await engine.advance(options.runId);
        printState(state);
      },
    );

  program
    .command("confirm-plan")
    .description("Approve the high-level plan (runs PRD + slicing), or reopen with feedback")
    .requiredOption("--run-id <id>", "run id")
    .option("--feedback <text>", "non-empty feedback discards the plan and reopens planning")
    .option("--config <path>", "config path")
    .option("--no-advance", "confirm without launching to-prd / issue-slicer")
    .action(
      async (options: {
        runId: string;
        feedback?: string;
        config?: string;
        advance: boolean;
      }) => {
        const engine = await openRunEngine(
          options.config,
          options.runId,
          dependencies.createBackend,
        );
        let state = await engine.confirmPlan(options.runId, { feedback: options.feedback });
        if (options.advance) state = await engine.advance(options.runId);
        printState(state);
      },
    );

  program
    .command("confirm-verification")
    .description("Confirm or edit verification settings before planning")
    .requiredOption("--run-id <id>", "run id")
    .option("--keep-current", "keep the run's current verification commands and path patterns", false)
    .option("--verification-command <command>", "replace verification commands with this command")
    .option(
      "--test-path-pattern <pattern>",
      "add a workflow.testPathPatterns entry (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      "--persist-project-defaults",
      "also write the confirmed settings into the project config file",
      false,
    )
    .option("--config <path>", "config path")
    .option("--no-advance", "confirm without launching the planner")
    .action(
      async (options: {
        runId: string;
        keepCurrent: boolean;
        verificationCommand?: string;
        testPathPattern: string[];
        persistProjectDefaults: boolean;
        config?: string;
        advance: boolean;
      }) => {
        const loaded = await loadConfig(options.config);
        let opened = await openRunHarness(loaded.config, options.runId, {
          backend: dependencies.createBackend(),
        });
        const hasOverrides =
          options.verificationCommand != null || options.testPathPattern.length > 0;
        if (options.keepCurrent && hasOverrides) {
          throw new Error("--keep-current cannot be combined with test command/pattern overrides");
        }
        const patch =
          options.keepCurrent || !hasOverrides
            ? undefined
            : {
                ...(options.verificationCommand != null
                  ? {
                      commands: {
                        verification: [{
                          id: "test",
                          command: options.verificationCommand,
                          timeoutMs: 10 * 60 * 1000,
                        }],
                      },
                    }
                  : {}),
                ...(options.testPathPattern.length > 0
                  ? { workflow: { testPathPatterns: options.testPathPattern } }
                  : {}),
              };
        let state = await opened.engine.confirmVerification(options.runId, {
          keepCurrent: options.keepCurrent,
          patch,
          persistProjectDefaults: options.persistProjectDefaults,
          configPath: loaded.path,
        });
        if (options.advance) {
          opened = await openRunHarness(loaded.config, options.runId, {
            backend: dependencies.createBackend(),
          });
          state = await opened.engine.advance(options.runId);
        }
        printState(state);
      },
    );

  program
    .command("retry-verification-baseline")
    .description("Retry the pre-planner verification baseline after a failure gate")
    .requiredOption("--run-id <id>", "run id")
    .option("--verification-command <command>", "replace verification commands before retrying")
    .option(
      "--persist-project-defaults",
      "also write the test command into the project config file",
      false,
    )
    .option("--config <path>", "config path")
    .option("--no-advance", "retry without launching the planner on success")
    .action(
      async (options: {
        runId: string;
        verificationCommand?: string;
        persistProjectDefaults: boolean;
        config?: string;
        advance: boolean;
      }) => {
        const loaded = await loadConfig(options.config);
        let opened = await openRunHarness(loaded.config, options.runId, {
          backend: dependencies.createBackend(),
        });
        if (options.persistProjectDefaults && !options.verificationCommand) {
          throw new Error("--persist-project-defaults requires --verification-command");
        }
        let state = await opened.engine.retryVerificationBaseline(options.runId, {
          verificationCommand: options.verificationCommand,
          persistProjectDefaults: options.persistProjectDefaults,
          configPath: loaded.path,
        });
        if (options.advance && !state.verificationBaselineReady) {
          opened = await openRunHarness(loaded.config, options.runId, {
            backend: dependencies.createBackend(),
          });
          state = await opened.engine.advance(options.runId);
        }
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
      const engine = await openRunEngine(options.config, options.runId, dependencies.createBackend);
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
        throw new Error(
          "Preflight commit-order controls have been removed. " +
            "Worktree runs start from the committed base and never import control-checkout dirt.",
        );
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
      const engine = await openRunEngine(
        options.config,
        options.runId,
        () => dependencies.createBackend("unused"),
        { validateWorktree: false },
      );
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
      const engine = await openRunEngine(
        options.config,
        options.runId,
        () => dependencies.createBackend("unused"),
        { validateWorktree: false },
      );
      const result = await engine.cancel(options.runId);
      if (result.pending) {
        console.log(`Cancellation pending for ${options.runId}; the advancing process will finish it.`);
      }
      printState(result.state);
    });

  program
    .command("cleanup")
    .description(
      "Remove a settled run workspace after conservative safety checks (worktree or Docker clone/volume)",
    )
    .requiredOption("--run-id <id>", "run id")
    .option("--config <path>", "config path")
    .option(
      "--discard",
      "explicitly discard unpublished commits not reachable from a retained named ref / import",
      false,
    )
    .action(async (options: { runId: string; config?: string; discard: boolean }) => {
      const engine = await openRunEngine(
        options.config,
        options.runId,
        () => dependencies.createBackend("unused"),
        { validateWorktree: false },
      );
      const result = await engine.cleanup(options.runId, { discard: options.discard });
      if (result.removed) {
        console.log(
          `Removed workspace for ${options.runId} (${result.reason}` +
            (result.retainedBranch ? `; retained branch ${result.retainedBranch}` : "") +
            ").",
        );
      } else {
        console.log(`Cleanup no-op for ${options.runId} (${result.reason}).`);
      }
      printState(result.state);
    });

  const execution = program
    .command("execution")
    .description("Docker execution runtime status, diagnostics, and operator controls");

  execution
    .command("status")
    .description("Show project execution runtime readiness (blocks Docker run creation when unhealthy)")
    .option("--repository <path>", "registered project repository (loads harness-home config)")
    .option("--config <path>", "config path")
    .option("--json", "print JSON", false)
    .action(async (options: { repository?: string; config?: string; json: boolean }) => {
      const { config, path: configPath } = await resolvedProjectConfig({
        config: options.config,
        repository: options.repository,
      });
      void configPath;
      const { createDockerClient } = await import("../infrastructure/container/docker-client.js");
      const { evaluateExecutionRuntimeStatus } = await import(
        "../application/execution-runtime-status.js"
      );
      const { resolveHarnessPaths } = await import("../application/paths.js");
      const paths = resolveHarnessPaths(config);
      const status = await evaluateExecutionRuntimeStatus({
        config,
        docker: createDockerClient(),
        repositoryRoot: paths.controlRoot,
        projectStateRoot: paths.stateRoot,
        collectEvidence: true,
        probeDocker: true,
      });
      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      console.log(`Runtime: ${status.runtime} · ready=${status.ready}`);
      for (const blocker of status.blockers) {
        console.log(`- ${blocker.code}: ${blocker.message}`);
        if (blocker.remediation) console.log(`  remediation: ${blocker.remediation}`);
      }
      if (status.networkNote) console.log(`Network: ${status.networkNote}`);
    });

  execution
    .command("prepare-worker")
    .description(
      "Probe Docker readiness and build/pull the maintained worker image (install wizard / operator setup)",
    )
    .option("--repository <path>", "registered project repository (loads harness-home config)")
    .option("--config <path>", "config path (alternative to --repository)")
    .option("--image <ref>", "pull/reuse this image instead of building from docker/worker/Dockerfile")
    .option("--tag <name:tag>", "local build tag", "agent-harness-worker:local")
    .option("--package-root <path>", "agent-harness package root containing docker/worker/Dockerfile")
    .option("--force-rebuild", "rebuild even when the local tag already exists", false)
    .option(
      "--write-settings",
      "pin workerImageDigest into the project settings file after a successful prepare",
      false,
    )
    .option(
      "--enable-runtime",
      "with --write-settings, also set execution.runtime=docker (default remains local)",
      false,
    )
    .option("--json", "print JSON", false)
    .action(
      async (options: {
        repository?: string;
        config?: string;
        image?: string;
        tag: string;
        packageRoot?: string;
        forceRebuild: boolean;
        writeSettings: boolean;
        enableRuntime: boolean;
        json: boolean;
      }) => {
        const { createDockerClient } = await import("../infrastructure/container/docker-client.js");
        const {
          prepareMaintainedWorkerImage,
          writeWorkerImageProjectSettings,
          defaultPackageRoot,
        } = await import("../application/prepare-worker-image.js");
        const { evaluateExecutionRuntimeStatus } = await import(
          "../application/execution-runtime-status.js"
        );

        const loaded = await resolvedProjectConfig({
          config: options.config,
          repository: options.repository,
        });
        let config = loaded.config;
        const configPath = loaded.path;

        const configuredWorker = config.execution?.docker?.workerImageDigest?.trim();
        const pullImage = options.image?.trim() || configuredWorker || undefined;
        const prepared = await prepareMaintainedWorkerImage({
          docker: createDockerClient(),
          packageRoot: options.packageRoot?.trim() || defaultPackageRoot(),
          pullImage,
          tag: options.tag,
          reuseLocalTag: !options.forceRebuild,
        });

        let settingsWritten = false;
        if (options.writeSettings) {
          await writeWorkerImageProjectSettings({
            configPath,
            workerImageDigest: prepared.workerImageDigest,
            enableDockerRuntime: options.enableRuntime,
          });
          settingsWritten = true;
          const reloaded = await loadConfig(configPath);
          config = reloaded.config;
        }

        const statusConfig =
          options.enableRuntime && settingsWritten
            ? config
            : {
                ...config,
                execution: {
                  ...config.execution,
                  docker: {
                    ...config.execution.docker,
                    workerImageDigest: prepared.workerImageDigest,
                  },
                },
              };

        const status = await evaluateExecutionRuntimeStatus({
          config: statusConfig,
          docker: createDockerClient(),
          repositoryRoot: config.repositoryRoot,
          projectStateRoot: config.stateDirectory,
          collectEvidence: true,
          probeDocker: true,
        });

        const payload = {
          ...prepared,
          readiness: {
            ready: prepared.readiness.ready,
            osType: prepared.readiness.osType,
            serverVersion: prepared.readiness.serverVersion,
            checks: prepared.readiness.checks.map((check) => ({
              id: check.id,
              ok: check.ok,
              detail: check.detail,
            })),
          },
          settingsWritten,
          enableRuntime: Boolean(options.enableRuntime && settingsWritten),
          configPath,
          status: {
            runtime: status.runtime,
            ready: status.ready,
            blockers: status.blockers,
          },
        };

        if (options.json) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          console.log(
            `Worker image ${prepared.source}: ${prepared.workerImageDigest} (tag ${prepared.tag})`,
          );
          console.log(`Docker ready=${prepared.readiness.ready}`);
          if (settingsWritten) {
            console.log(
              `Wrote project settings${options.enableRuntime ? " (execution.runtime=docker)" : " (worker digest only)"}: ${configPath}`,
            );
          }
          console.log(`Execution status ready=${status.ready} (runtime=${status.runtime})`);
          for (const blocker of status.blockers) {
            console.log(`- ${blocker.code}: ${blocker.message}`);
            if (blocker.remediation) console.log(`  remediation: ${blocker.remediation}`);
          }
        }

        if (!prepared.readiness.ready) {
          process.exitCode = 1;
        }
      },
    );

  execution
    .command("approve-base")
    .description(
      "Pull/pin known toolchain base images into the shared harness-home approvedBaseImages catalog (project-agnostic)",
    )
    .option("--repository <path>", "optional: detect one stack from a registered project")
    .option("--config <path>", "optional project config path (writes there instead of harness home)")
    .option("--home <path>", "harness home root (default: platform AGENT_HARNESS_HOME)")
    .option(
      "--image <ref>",
      "override pull reference when approving a single stack",
    )
    .option(
      "--stack <id>",
      "approve one stack family (node|python|go|rust|jvm)",
    )
    .option(
      "--all",
      "approve every known stack family into the shared catalog (default when no --stack/--repository)",
      false,
    )
    .option("--force-pull", "pull even when the image already exists locally", false)
    .option(
      "--write-settings",
      "persist approvedBaseImages (harness-home config.yaml by default)",
      false,
    )
    .option(
      "--project-settings",
      "with --write-settings, write the project config instead of harness-home (not recommended)",
      false,
    )
    .option("--json", "print JSON", false)
    .action(
      async (options: {
        repository?: string;
        config?: string;
        home?: string;
        image?: string;
        stack?: string;
        all: boolean;
        forcePull: boolean;
        writeSettings: boolean;
        projectSettings: boolean;
        json: boolean;
      }) => {
        const { createDockerClient } = await import("../infrastructure/container/docker-client.js");
        const {
          approveStackBaseImage,
          approveKnownStackBaseImages,
          writeApprovedBaseImagesSettings,
          harnessHomeConfigPath,
        } = await import("../application/approve-base-image.js");
        const { evaluateExecutionRuntimeStatus } = await import(
          "../application/execution-runtime-status.js"
        );
        const { KNOWN_STACK_BASE_FAMILIES } = await import(
          "../application/execution-image-generator.js"
        );
        const { resolveHarnessHome } = await import("../application/harness-home.js");
        const { access } = await import("node:fs/promises");

        const home = resolveHarnessHome({ homeRoot: options.home });
        const homeConfigPath = harnessHomeConfigPath(home);
        try {
          await access(homeConfigPath);
        } catch {
          await writeFile(homeConfigPath, defaultConfigYaml(), "utf8");
        }

        const stackOption = options.stack?.trim();
        if (stackOption && !(stackOption in KNOWN_STACK_BASE_FAMILIES)) {
          throw new Error(
            `Unknown --stack ${stackOption}. Expected one of: ${Object.keys(KNOWN_STACK_BASE_FAMILIES).join(", ")}`,
          );
        }

        const wantsAll =
          options.all ||
          (!stackOption && !options.repository?.trim() && !options.image?.trim());

        let existingApprovedBaseImages: string[] = [];
        let projectConfig: HarnessConfig | undefined;
        let projectConfigPath: string | undefined;
        if (options.config || options.repository) {
          const loaded = await resolvedProjectConfig({
            config: options.config,
            repository: options.repository,
            home: options.home,
          });
          projectConfig = loaded.config;
          projectConfigPath = loaded.path;
          existingApprovedBaseImages = loaded.config.execution?.docker?.approvedBaseImages ?? [];
        } else {
          const homeLoaded = await loadConfig(homeConfigPath);
          existingApprovedBaseImages =
            homeLoaded.config.execution?.docker?.approvedBaseImages ?? [];
        }

        const docker = createDockerClient();
        let approvedBaseImages: string[];
        let bases: Array<{
          stack: string;
          family: string;
          baseImageDigest: string;
          source: string;
        }>;

        if (wantsAll) {
          const approved = await approveKnownStackBaseImages({
            docker,
            existingApprovedBaseImages,
            reuseLocal: !options.forcePull,
          });
          approvedBaseImages = approved.approvedBaseImages;
          bases = approved.bases;
        } else {
          const approved = await approveStackBaseImage({
            docker,
            repositoryRoot: projectConfig?.repositoryRoot,
            existingApprovedBaseImages,
            image: options.image?.trim() || undefined,
            stack: stackOption as keyof typeof KNOWN_STACK_BASE_FAMILIES | undefined,
            reuseLocal: !options.forcePull,
          });
          approvedBaseImages = approved.approvedBaseImages;
          bases = [approved];
        }

        const writeToProject = Boolean(options.projectSettings && projectConfigPath);
        const settingsPath = writeToProject ? projectConfigPath! : homeConfigPath;

        let settingsWritten = false;
        if (options.writeSettings) {
          await writeApprovedBaseImagesSettings({
            configPath: settingsPath,
            approvedBaseImages,
          });
          settingsWritten = true;
        }

        let statusConfig: HarnessConfig;
        if (projectConfig) {
          statusConfig = {
            ...projectConfig,
            execution: {
              ...projectConfig.execution,
              docker: {
                ...projectConfig.execution.docker,
                approvedBaseImages,
              },
            },
          };
        } else {
          const homeLoaded = await loadConfig(homeConfigPath);
          statusConfig = {
            ...homeLoaded.config,
            execution: {
              ...homeLoaded.config.execution,
              docker: {
                ...homeLoaded.config.execution.docker,
                approvedBaseImages,
              },
            },
          };
        }

        const status = await evaluateExecutionRuntimeStatus({
          config: statusConfig,
          docker,
          repositoryRoot: statusConfig.repositoryRoot,
          projectStateRoot: statusConfig.stateDirectory,
          collectEvidence: Boolean(projectConfig),
          probeDocker: true,
          includePortBinding: false,
        });

        const payload = {
          scope: writeToProject ? "project" : "harness-home",
          bases,
          approvedBaseImages,
          settingsWritten,
          configPath: settingsPath,
          status: {
            runtime: status.runtime,
            ready: status.ready,
            blockers: status.blockers,
          },
        };

        if (options.json) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          console.log(
            `Approved ${bases.length} base image(s) for shared catalog (${payload.scope}):`,
          );
          for (const base of bases) {
            console.log(`- ${base.stack}: ${base.baseImageDigest} (${base.source})`);
          }
          if (settingsWritten) {
            console.log(`Wrote approvedBaseImages to ${settingsPath}`);
          } else {
            console.log("Dry run only — re-run with --write-settings to persist.");
          }
          console.log(`Execution status ready=${status.ready} (runtime=${status.runtime})`);
          for (const blocker of status.blockers) {
            console.log(`- ${blocker.code}: ${blocker.message}`);
            if (blocker.remediation) console.log(`  remediation: ${blocker.remediation}`);
          }
        }
      },
    );

  execution
    .command("diagnostics")
    .description("Redacted Docker/run diagnostics (inspect, digests, bundle hashes, worker health)")
    .requiredOption("--run-id <id>", "run id")
    .option("--config <path>", "config path")
    .option("--json", "print JSON", true)
    .action(async (options: { runId: string; config?: string; json: boolean }) => {
      const { config } = await loadConfig(options.config);
      const { createDockerClient } = await import("../infrastructure/container/docker-client.js");
      const { collectExecutionDiagnostics } = await import(
        "../application/execution-diagnostics.js"
      );
      const { loadRunWorkspace } = await import("../config/io.js");
      const { ensureDockerWorkerSession } = await import(
        "../application/docker-worker-session.js"
      );
      const workspace = await loadRunWorkspace(config, options.runId).catch(() => undefined);
      const docker = createDockerClient();
      let workerHealth: { ok: boolean; detail?: string } | undefined;
      if (workspace?.kind === "docker-clone") {
        try {
          const session = await ensureDockerWorkerSession({
            projectConfig: config,
            runId: options.runId,
            docker,
            startIfMissing: false,
          });
          await session.client.health();
          workerHealth = { ok: true };
        } catch (error) {
          workerHealth = {
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }
      const diagnostics = await collectExecutionDiagnostics({
        projectConfig: config,
        runId: options.runId,
        workspace,
        docker,
        workerHealth,
      });
      console.log(JSON.stringify(diagnostics, null, 2));
    });

  execution
    .command("approve-image")
    .description("Approve the generated execution Dockerfile for a run (non-interactive)")
    .requiredOption("--run-id <id>", "run id")
    .option("--config <path>", "config path")
    .action(async (options: { runId: string; config?: string }) => {
      const { config } = await loadConfig(options.config);
      const runConfig = await loadRunConfig(config, options.runId);
      const { resolveHarnessPaths } = await import("../application/paths.js");
      const {
        prepareExecutionImage,
        approveExecutionImage,
      } = await import("../application/execution-image-service.js");
      const paths = resolveHarnessPaths(config);
      const prepared = await prepareExecutionImage({
        config: runConfig,
        stateRoot: paths.stateRoot,
        runId: options.runId,
        projectStateRoot: paths.stateRoot,
      });
      if (prepared.status === "blocked") {
        throw new Error(prepared.reason ?? "Execution image blocked");
      }
      if (!("generated" in prepared) || !prepared.generated) {
        throw new Error("No generated image to approve");
      }
      const record = await approveExecutionImage({
        stateRoot: paths.stateRoot,
        runId: options.runId,
        projectStateRoot: paths.stateRoot,
        generated: prepared.generated,
        cacheKey: prepared.cacheKey,
      });
      console.log(JSON.stringify(record, null, 2));
    });

  execution
    .command("build-image")
    .description("Build an approved execution image (retry after failure)")
    .requiredOption("--run-id <id>", "run id")
    .option("--config <path>", "config path")
    .action(async (options: { runId: string; config?: string }) => {
      const { config } = await loadConfig(options.config);
      const runConfig = await loadRunConfig(config, options.runId);
      const { createDockerClient } = await import("../infrastructure/container/docker-client.js");
      const { resolveHarnessPaths } = await import("../application/paths.js");
      const { buildApprovedExecutionImage } = await import(
        "../application/execution-image-service.js"
      );
      const paths = resolveHarnessPaths(config);
      const result = await buildApprovedExecutionImage({
        stateRoot: paths.stateRoot,
        runId: options.runId,
        projectStateRoot: paths.stateRoot,
        docker: createDockerClient(),
        tag: `agent-harness-run-${options.runId}`.toLowerCase().slice(0, 128),
        timeoutMs: runConfig.execution?.docker?.buildTimeoutMs,
        dockerPolicy: runConfig.execution?.docker,
      });
      console.log(JSON.stringify({ imageDigest: result.imageDigest }, null, 2));
    });

  execution
    .command("approve-and-build-image")
    .description("Approve the generated Dockerfile and build it (writes image.digest)")
    .requiredOption("--run-id <id>", "run id")
    .option("--config <path>", "config path")
    .action(async (options: { runId: string; config?: string }) => {
      const { config } = await loadConfig(options.config);
      const runConfig = await loadRunConfig(config, options.runId);
      const { createDockerClient } = await import("../infrastructure/container/docker-client.js");
      const { resolveHarnessPaths } = await import("../application/paths.js");
      const { approveAndBuildExecutionImage } = await import(
        "../application/execution-image-service.js"
      );
      const paths = resolveHarnessPaths(config);
      const result = await approveAndBuildExecutionImage({
        config: runConfig,
        stateRoot: paths.stateRoot,
        runId: options.runId,
        projectStateRoot: paths.stateRoot,
        repositoryRoot: paths.controlRoot,
        docker: createDockerClient(),
        tag: `agent-harness-run-${options.runId}`.toLowerCase().slice(0, 128),
        timeoutMs: runConfig.execution?.docker?.buildTimeoutMs,
        dockerPolicy: runConfig.execution?.docker,
      });
      console.log(JSON.stringify({ imageDigest: result.imageDigest }, null, 2));
    });

  execution
    .command("recover-container")
    .description("Recreate the worker container against the retained named volume (never reseed)")
    .requiredOption("--run-id <id>", "run id")
    .option("--config <path>", "config path")
    .action(async (options: { runId: string; config?: string }) => {
      const { config } = await loadConfig(options.config);
      const { createDockerClient } = await import("../infrastructure/container/docker-client.js");
      const { loadRunWorkspace } = await import("../config/io.js");
      const { ensureDockerWorkerSession } = await import(
        "../application/docker-worker-session.js"
      );
      const workspace = await loadRunWorkspace(config, options.runId);
      if (workspace.kind !== "docker-clone") {
        throw new Error(`Run ${options.runId} is not a docker-clone workspace`);
      }
      const session = await ensureDockerWorkerSession({
        projectConfig: config,
        runId: options.runId,
        docker: createDockerClient(),
        image: workspace.imageDigest,
        workspaceVolumeName: workspace.workspaceVolumeName,
        startIfMissing: true,
      });
      console.log(
        JSON.stringify(
          {
            containerName: session.execution.containerName,
            hostPort: session.execution.hostPort,
            lifecycle: session.execution.lifecycle,
          },
          null,
          2,
        ),
      );
    });

  execution
    .command("reconcile-orphans")
    .description("Inspect harness-labeled containers; optionally remove conservative orphans")
    .option("--config <path>", "config path")
    .option("--apply", "remove containers that pass age/state checks (never volumes)", false)
    .option("--json", "print JSON", false)
    .action(async (options: { config?: string; apply: boolean; json: boolean }) => {
      const { config } = await loadConfig(options.config);
      const { createDockerClient } = await import("../infrastructure/container/docker-client.js");
      const { reconcileOrphanContainers } = await import("../application/orphan-reconciler.js");
      const { loadRunWorkspace } = await import("../config/io.js");
      const { resolveHarnessPaths } = await import("../application/paths.js");
      const { RunStore } = await import("../store.js");
      const paths = resolveHarnessPaths(config);
      const store = new RunStore(config, paths.stateRoot);
      await store.initialize();
      const { states } = await store.listWithFailures();
      const knownRuns = [];
      for (const state of states) {
        try {
          const workspace = await loadRunWorkspace(config, state.runId);
          if (workspace.kind !== "docker-clone") continue;
          knownRuns.push({
            runId: state.runId,
            phase: state.phase,
            removedAt: workspace.removedAt,
            workspaceVolumeName: workspace.workspaceVolumeName,
            containerName: workspace.containerName,
          });
        } catch {
          // skip
        }
      }
      const report = await reconcileOrphanContainers({
        docker: createDockerClient(),
        knownRuns,
        apply: options.apply,
      });
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log(`Inspected ${report.inspected} managed container(s); removed ${report.removed.length}.`);
      for (const candidate of report.candidates) {
        console.log(
          `- ${candidate.name}: ${candidate.decision.action} (${candidate.decision.reason})`,
        );
      }
    });

  program
    .command("unlock")
    .description("Inspect locks and force-remove a stale run lock")
    .requiredOption("--run-id <id>", "run id")
    .option("--inspect-only", "print lock status without removing anything", false)
    .option("--config <path>", "config path")
    .action(async (options: {
      runId: string;
      inspectOnly: boolean;
      config?: string;
    }) => {
      const engine = await openRunEngine(
        options.config,
        options.runId,
        () => dependencies.createBackend("unused"),
        { validateWorktree: false },
      );
      const store = engine.store;
      const runLock = await store.inspectRunLock(options.runId);
      const workspaceAdminLock = await store.inspectWorkspaceAdminLock();
      const sharedIndexLock = await store.inspectSharedIndexLock();
      printLockStatus("run", runLock);
      printLockStatus("workspace-admin", workspaceAdminLock);
      printLockStatus("shared-index", sharedIndexLock);
      if (options.inspectOnly) return;

      if (runLock) printLockRemoval("run", runLock);
      else console.log(`No run lock found for ${options.runId}.`);
      const result = await store.unlock(options.runId, { repo: false });
      if (result.run && runLock) console.log(`Removed run lock: ${runLock.path}`);
    });

  program
    .command("ui")
    .description("Open the centralized loopback dashboard")
    .option("--config <path>", "config path")
    .option("--project <project-key>", "external project key")
    .option("--repository <path>", "registered repository path")
    .option("--home <path>", "harness home override")
    .option("--port <number>", "loopback port", "8787")
    .option("--no-open", "do not open the browser automatically")
    .action(async (options: {
      config?: string;
      project?: string;
      repository?: string;
      home?: string;
      port: string;
      open: boolean;
    }) => {
      const loaded = await resolvedProjectConfig({
        config: options.config,
        project: options.project,
        repository: options.repository,
        home: options.home,
      });
      const ui = await dependencies.startUiServer({
        config: loaded.config,
        configPath: loaded.path,
        backend: dependencies.createBackend(),
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

  const knowledge = program.command("knowledge").description("Manage local lexical and repository-intelligence retrieval");

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

  // Hidden: one-shot seed-bundle materialization inside an init container (slice 4).
  program
    .command("workspace-init", { hidden: true })
    .description("Initialize /workspace from a read-only seed bundle (internal)")
    .requiredOption("--workspace <path>", "clone root", "/workspace")
    .requiredOption("--seed-bundle <path>", "read-only seed.bundle path")
    .requiredOption("--base-sha <sha>", "exact detached checkout SHA")
    .requiredOption("--run-id <id>", "run id for clone identity")
    .requiredOption("--seed-bundle-hash <hash>", "sha256:… of the seed bundle")
    .option("--generation <n>", "clone generation", "0")
    .action(
      async (options: {
        workspace: string;
        seedBundle: string;
        baseSha: string;
        runId: string;
        seedBundleHash: string;
        generation: string;
      }) => {
        const { initializeCloneFromSeedBundle } = await import("../git/bundle-transport.js");
        await initializeCloneFromSeedBundle({
          workspacePath: options.workspace,
          seedBundlePath: options.seedBundle,
          baseSha: options.baseSha,
          identity: {
            runId: options.runId,
            baseSha: options.baseSha,
            seedBundleHash: options.seedBundleHash,
            generation: Number(options.generation) || 0,
            createdAt: new Date().toISOString(),
          },
        });
        console.log(
          JSON.stringify({
            ok: true,
            workspace: options.workspace,
            baseSha: options.baseSha,
          }),
        );
      },
    );

  program
    .command("workspace-probe", { hidden: true })
    .description("Probe clone identity / HEAD inside a workspace volume (internal)")
    .requiredOption("--workspace <path>", "clone root", "/workspace")
    .requiredOption("--base-sha <sha>", "recorded base SHA")
    .requiredOption("--seed-bundle-hash <hash>", "recorded seed hash")
    .option("--generation <n>", "clone generation", "0")
    .option("--run-id <id>", "optional run id")
    .action(
      async (options: {
        workspace: string;
        baseSha: string;
        seedBundleHash: string;
        generation: string;
        runId?: string;
      }) => {
        const { assertCloneReopenInvariants } = await import("../git/bundle-transport.js");
        const facts = await assertCloneReopenInvariants({
          workspacePath: options.workspace,
          expected: {
            ...(options.runId ? { runId: options.runId } : {}),
            baseSha: options.baseSha,
            seedBundleHash: options.seedBundleHash,
            generation: Number(options.generation) || 0,
          },
        });
        console.log(JSON.stringify(facts));
      },
    );

  // Hidden: fail-closed sandbox isolation self-check inside a disposable probe container.
  program
    .command("sandbox-isolation-self-check", { hidden: true })
    .description("Prove workspace write + sandbox deny of /run-state (internal)")
    .requiredOption("--workspace <path>", "writable workspace root", "/workspace")
    .requiredOption("--run-state <path>", "run-state mount", "/run-state")
    .requiredOption("--rpc-secret <path>", "RPC secret path under run-state")
    .action(
      async (options: { workspace: string; runState: string; rpcSecret: string }) => {
        const { access, readFile, writeFile } = await import("node:fs/promises");
        const pathMod = await import("node:path");
        const { evaluateSandboxIsolationSelfCheck } = await import(
          "../application/sandbox-isolation-probe.js"
        );
        const { prohibitedAgentPathAccess } = await import(
          "../infrastructure/agents/step-utils.js"
        );

        let workspaceWrite = false;
        try {
          await writeFile(
            pathMod.join(options.workspace, ".harness-isolation-probe"),
            "ok\n",
            "utf8",
          );
          workspaceWrite = true;
        } catch {
          workspaceWrite = false;
        }

        // Unsandboxed visibility of /run-state proves the mount exists; Cursor
        // sandbox + prohibitedAgentPathAccess must still deny agent tools.
        let mountVisibleToUnsandboxed = false;
        try {
          await access(options.runState);
          mountVisibleToUnsandboxed = true;
        } catch {
          mountVisibleToUnsandboxed = false;
        }

        const policyDeniesRunStateRead =
          prohibitedAgentPathAccess({ path: options.runState }, options.workspace) != null ||
          prohibitedAgentPathAccess(
            { path: pathMod.join(options.runState, "probe-marker.txt") },
            options.workspace,
          ) != null;
        const policyDeniesRpcSecret =
          prohibitedAgentPathAccess({ path: options.rpcSecret }, options.workspace) != null;
        const policyDeniesOutside =
          prohibitedAgentPathAccess({ path: "/etc/passwd" }, options.workspace) != null;

        // Attempt real FS write to run-state (unsandboxed process may succeed);
        // report denial based on sandbox policy, not unsandboxed FS.
        let unsandboxedWroteRunState = false;
        try {
          await writeFile(
            pathMod.join(options.runState, ".probe-should-not-be-agent-writable"),
            "x\n",
            "utf8",
          );
          unsandboxedWroteRunState = true;
        } catch {
          unsandboxedWroteRunState = false;
        }

        let unsandboxedReadSecret = false;
        try {
          await readFile(options.rpcSecret, "utf8");
          unsandboxedReadSecret = true;
        } catch {
          unsandboxedReadSecret = false;
        }

        const evaluated = evaluateSandboxIsolationSelfCheck({
          workspaceWritable: workspaceWrite,
          // Fail closed: agent sandbox policy must deny these even if the
          // unsandboxed worker process can see the mount.
          canReadRunState: !policyDeniesRunStateRead,
          canWriteRunState: !policyDeniesRunStateRead,
          canReadRpcSecret: !policyDeniesRpcSecret,
          canAccessOutsideWorkspace: !policyDeniesOutside,
        });

        const payload = {
          ...evaluated,
          mountVisibleToUnsandboxed,
          unsandboxedWroteRunState,
          unsandboxedReadSecret,
          note:
            "Filesystem isolation ≠ exfiltration-proof networking; Cursor sandboxEnabled is required at agent runtime.",
        };
        console.log(JSON.stringify(payload));
        if (!evaluated.ok) process.exitCode = 1;
      },
    );

  // Hidden container entrypoint (not listed in --help). Matches WORKER_IMAGE_BINARY_PATH
  // semantics: long-lived authenticated RPC worker for one run.
  program
    .command("worker", { hidden: true })
    .description("Run the per-run Docker worker RPC server (internal)")
    .requiredOption("--run-id <id>", "run id")
    .option("--listen <host:port>", "bind address", "0.0.0.0:8787")
    .option("--secret-file <path>", "read-only RPC token file")
    .option("--run-state <path>", "mounted run-state directory", "/run-state")
    .option("--fake-backend", "use FakeBackend (tests/dev)", false)
    .action(
      async (options: {
        runId: string;
        listen: string;
        secretFile?: string;
        runState: string;
        fakeBackend: boolean;
      }) => {
        const { runWorker } = await import("../worker/run-worker.js");
        const listen = options.listen.trim();
        const colon = listen.lastIndexOf(":");
        if (colon < 0) throw new Error(`Invalid --listen ${listen}; expected host:port`);
        const host = listen.slice(0, colon) || "0.0.0.0";
        const port = Number(listen.slice(colon + 1));
        if (!Number.isFinite(port) || port <= 0) {
          throw new Error(`Invalid --listen port in ${listen}`);
        }
        const worker = await runWorker({
          runId: options.runId,
          host,
          port,
          secretFile: options.secretFile,
          runStatePath: options.runState,
          fakeBackend: options.fakeBackend,
        });
        const shutdown = async () => {
          await worker.close();
          process.exit(0);
        };
        process.on("SIGTERM", () => {
          void shutdown();
        });
        process.on("SIGINT", () => {
          void shutdown();
        });
        // Keep the process alive until shutdown RPC / signal.
        await new Promise(() => undefined);
      },
    );
  
  return program;
}

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

async function resolvedConfig(
  configPath: string | undefined,
  baseBranch?: string,
  rag?: string,
): Promise<HarnessConfig> {
  const { config } = await resolvedProjectConfig({ config: configPath });
  return applyRunOverrides(config, baseBranch, rag);
}

async function resolvedProjectConfig(options: {
  config?: string;
  project?: string;
  repository?: string;
  home?: string;
}): Promise<{
  config: HarnessConfig;
  path: string;
  lookup?: Awaited<ReturnType<typeof loadExternalProjectConfig>>["lookup"];
}> {
  if (options.config) {
    const loaded = await loadConfig(options.config);
    return { config: loaded.config, path: loaded.path };
  }
  const home = resolveHarnessHome({ homeRoot: options.home });
  const loaded = await loadExternalProjectConfig({
    projectKey: options.project,
    repository: options.repository,
    home,
  });
  return {
    config: loaded.config,
    path: loaded.path,
    lookup: loaded.lookup,
  };
}

async function applyRunOverrides(
  config: HarnessConfig,
  baseBranch?: string,
  rag?: string,
): Promise<HarnessConfig> {
  let next = config;
  if (rag != null) {
    if (rag !== "on" && rag !== "off") throw new Error("--rag must be 'on' or 'off'");
    next = { ...next, workflow: { ...next.workflow, rag: rag === "on" } };
  }
  if (baseBranch != null) {
    if (!next.git.enabled) {
      throw new Error("--base-branch cannot be set when git is disabled");
    }
    const branches = await new GitService(next).listLocalBranches();
    if (!branches.includes(baseBranch)) {
      throw new Error(`Unknown local branch: ${baseBranch}`);
    }
    next = { ...next, git: { ...next.git, baseBranch } };
  }
  return next;
}

async function runConfig(configPath: string | undefined, runId: string): Promise<HarnessConfig> {
  const { config } = await loadConfig(configPath);
  return loadRunConfig(config, runId);
}

async function openRunEngine(
  configPath: string | undefined,
  runId: string,
  createBackend: CliDependencies["createBackend"],
  options?: { validateWorktree?: boolean },
): Promise<HarnessEngine> {
  const { config } = await loadConfig(configPath);
  const opened = await openRunHarness(
    config,
    runId,
    { backend: createBackend() },
    options,
  );
  return opened.engine;
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

function printLockStatus(
  kind: string,
  info: { path: string; body: { pid: number; hostname: string; at: string; runId?: string; action?: string } | null; ageMs: number | null } | null,
): void {
  if (!info) {
    console.log(`Lock ${kind}: absent`);
    return;
  }
  const ageSeconds = info.ageMs == null ? "unknown" : `${Math.round(info.ageMs / 1000)}s`;
  if (info.body) {
    console.log(
      `Lock ${kind}: held pid=${info.body.pid} hostname=${info.body.hostname}` +
        (info.body.runId ? ` run=${info.body.runId}` : "") +
        (info.body.action ? ` action=${info.body.action}` : "") +
        ` at=${info.body.at} age=${ageSeconds} path=${info.path}`,
    );
  } else {
    console.log(`Lock ${kind}: present (unparseable body, age=${ageSeconds}) path=${info.path}`);
  }
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
  if (state.phase === "awaiting_input" && state.grillReady) {
    console.log(`Grilling complete: ${state.grillReady.summary}`);
    console.log(
      `Continue with: agent-harness confirm-grill --run-id ${state.runId}`,
    );
    console.log(
      `Or reopen with: agent-harness confirm-grill --run-id ${state.runId} --feedback "…"`,
    );
  }
  if (state.phase === "awaiting_input" && state.planReady) {
    console.log(`Plan / PRD / scenarios ready: ${state.planReady.summary}`);
    if (state.scenarios.length > 0) {
      console.log(`Scenarios: ${state.scenarios.map((item) => item.id).join(", ")}`);
    }
    console.log(
      `Approve with: agent-harness confirm-plan --run-id ${state.runId}`,
    );
    console.log(
      `Or reopen with: agent-harness confirm-plan --run-id ${state.runId} --feedback "…"`,
    );
  }
  if (state.phase === "awaiting_input" && state.verificationReady) {
    console.log(`Verification settings ready: ${state.verificationReady.summary}`);
    console.log(
      `Confirm with: agent-harness confirm-verification --run-id ${state.runId}`,
    );
    console.log(
      `Or keep current: agent-harness confirm-verification --run-id ${state.runId} --keep-current`,
    );
  }
  if (state.phase === "awaiting_input" && state.verificationBaselineReady) {
    console.log(`Verification baseline failed: ${state.verificationBaselineReady.summary}`);
    console.log(
      `Retry with: agent-harness retry-verification-baseline --run-id ${state.runId}`,
    );
    console.log(
      `Or edit the command: agent-harness retry-verification-baseline --run-id ${state.runId} --verification-command "…"`,
    );
  }
  if (state.phase === "scenario_testing") {
    const active = state.scenarios.find((item) => item.status === "active" || item.status === "pending");
    console.log(
      `Scenario testing: ${state.scenarios.filter((item) => item.status === "passing").length}/${state.scenarios.length} passing` +
        (active ? ` · current ${active.id}` : ""),
    );
  }
  if (state.phase === "crystallizing") {
    const pct = state.coverage ? `${(state.coverage.percentage * 100).toFixed(1)}%` : "not measured";
    console.log(`Crystallizing coverage: ${pct}`);
  }
  if (state.phase === "final_review") {
    console.log(`Final review attempt ${state.finalReviewAttempts}`);
  }
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
 * Default deploy writes git.enabled: true. Starting a run against a plain folder
 * then fails at the dirty-tree preflight with a raw `git status` exit 128 — warn now.
 */
async function warnIfNotGitRepository(project: string): Promise<void> {
  if (await isGitRepository(project)) return;
  console.log("");
  console.log("This project is not a git repository, but the deployed config has git.enabled: true.");
  console.log("Starting a run (dashboard Start reflect) will block until you either:");
  console.log(`  1. git init && git add . && git commit -m "initial"   (in ${project})`);
  console.log("  2. set git.enabled: false in agent-harness.config.yaml");
}

/**
 * Deploy leaves committable config/ignore files untracked; a run refuses to start
 * on a dirty tree, so surface that now, not later.
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

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function splitProjectIds(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((id) => id.trim()).filter(Boolean);
}

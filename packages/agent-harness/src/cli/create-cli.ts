import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import type { AgentBackend } from "../infrastructure/agents/types.js";
import { HarnessFailure } from "../errors.js";
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
import {
  openHostRunControl,
  type OpenRunHarnessOptions,
} from "../application/run-engine-factory.js";
import type { HostRunControl } from "../application/host-run-control.js";
import { dispatchHostRunAction } from "../application/host-run-dispatch.js";
import { GitService } from "../git.js";
import { LocalKnowledgeBase } from "../knowledge.js";
import { startUiServer, type UiServer } from "../ui/server.js";
import { createDockerClient } from "../infrastructure/container/docker-client.js";
import type { DockerClient } from "../infrastructure/container/types.js";
import type { RunState } from "../domain.js";
import { resolveRunBaseBranch } from "../application/run-base-branch.js";
import type { OperatorRunRepository } from "../application/run-repository.js";
import { dumpProfileConfig } from "../vnext/boot/boot-profile.js";
import { profileForDump } from "../vnext/profiles/index.js";

export type CliDependencies = {
  createBackend: (apiKey?: string) => AgentBackend;
  createDockerClient: () => DockerClient;
  startUiServer: (options: Parameters<typeof startUiServer>[0]) => Promise<UiServer>;
};

export function productionCliDependencies(): CliDependencies {
  return {
    createBackend: () => createHostControlBackend(),
    createDockerClient,
    startUiServer,
  };
}

/**
 * Production CLI commands are host-control adapters. Agent execution is
 * supplied later by startUiServer's disposable SandboxAgentBackend.
 */
function createHostControlBackend(): AgentBackend {
  return {
    readiness: () => ({ ready: true }),
    workspaceCapabilities: () => ({
      canRestrictWritableWorkspace: true,
      providerId: "host-control",
    }),
    async run() {
      throw new HarnessFailure(
        "Host control attempted agent execution; production agents must run in a disposable sandbox.",
        "execution",
        false,
      );
    },
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

  const vnext = program
    .command("vnext")
    .description("Inspect the Cordis-composed Docker-only runtime");

  vnext
    .command("dump-config")
    .description("Render and validate a resolved vNext plugin profile without starting Docker")
    .option("--profile <name>", "host, worker, or deterministic-test", "host")
    .action((options: { profile: string }) => {
      console.log(dumpProfileConfig(profileForDump(options.profile)));
    });

  program
    .command("cursor-provider-sdk-smoke-child", { hidden: true })
    .description("Run the pinned Cursor SDK provider contract inside the worker image")
    .action(async () => {
      // The command owns its own JSON emission and process-failure handling so
      // the recorder always receives a result line, even on a hard SDK crash.
      const { runCursorProviderSdkSmokeChildCommand } = await import(
        "../application/cursor-provider-sdk-smoke-child.js"
      );
      process.exitCode = await runCursorProviderSdkSmokeChildCommand();
    });

  program
    .command("sandbox-agent-child", { hidden: true })
    .description("Execute one brokered agent invocation inside a disposable sandbox")
    .action(async () => {
      const { runSandboxAgentChild } = await import(
        "../application/sandbox-agent-child.js"
      );
      const result = await runSandboxAgentChild(JSON.parse(await readProcessStdin()));
      process.stdout.write(`${JSON.stringify(result)}\n`);
    });

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
    .option("--home <path>", "harness home override")
    .action(async (options: {
      repository: string;
      name?: string;
      home?: string;
    }) => {
      const home = resolveHarnessHome({ homeRoot: options.home });
      const registry = new ProjectRegistry(home);
      const guidance = await seedExternalGuidance(home);
      const lookup = await registry.add({
        repository: options.repository,
        name: options.name,
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
        const idea = options.idea.startsWith("@")
          ? await readFile(path.resolve(options.idea.slice(1)), "utf8")
          : options.idea;
        let state!: RunState;
        await withCliControlServer(config, resolved.path, dependencies, async (control) => {
          state = await control.runLifecycle.createRun(
            config,
            idea,
            options.runId ?? randomUUID(),
          );
          if (options.advance) await control.runLifecycle.enqueue(state.runId);
          state = await control.runLifecycle.productState(state.runId);
        });
        printState(state);
      },
    );

  program
    .command("continue")
    .description("Advance a run from its persisted artifacts")
    .requiredOption("--run-id <id>", "run id")
    .option("--config <path>", "config path")
    .option("--project <project-key>", "external project key")
    .option("--repository <path>", "registered repository path")
    .option("--home <path>", "harness home override")
    .action(async (options: RunCommandOptions) => {
      const resolved = await resolvedProjectConfig(options);
      let state!: RunState;
      await withCliControlServer(resolved.config, resolved.path, dependencies, async (control) => {
        await control.runLifecycle.enqueue(options.runId);
        state = await control.runLifecycle.productState(options.runId);
      });
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
        const loaded = await loadConfig(options.config);
        const docker = dependencies.createDockerClient();
        const runConfig = await loadRunConfig(loaded.config, options.runId);
        await invokeDockerWorkerAction({
          projectConfig: loaded.config,
          runConfig,
          runId: options.runId,
          docker,
          backend: dependencies.createBackend(),
          action: "answer",
          body: {
            answers: [{ questionId: options.question, answer: options.text }],
          },
        });
        if (options.advance) {
          await invokeDockerWorkerAction({
            projectConfig: loaded.config,
            runConfig,
            runId: options.runId,
            docker,
            backend: dependencies.createBackend(),
            action: "advance",
          });
        }
        const control = await openHostControl(
          options.config,
          options.runId,
          () => dependencies.createBackend("unused"),
          { validateWorkspace: false },
        );
        printState(await control.status(options.runId));
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
        const loaded = await loadConfig(options.config);
        const docker = dependencies.createDockerClient();
        const runConfig = await loadRunConfig(loaded.config, options.runId);
        await invokeDockerWorkerAction({
          projectConfig: loaded.config,
          runConfig,
          runId: options.runId,
          docker,
          backend: dependencies.createBackend(),
          action: "confirm_grill",
          body: { feedback: options.feedback },
        });
        if (options.advance) {
          await invokeDockerWorkerAction({
            projectConfig: loaded.config,
            runConfig,
            runId: options.runId,
            docker,
            backend: dependencies.createBackend(),
            action: "advance",
          });
        }
        const control = await openHostControl(
          options.config,
          options.runId,
          () => dependencies.createBackend("unused"),
          { validateWorkspace: false },
        );
        printState(await control.status(options.runId));
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
        const loaded = await loadConfig(options.config);
        const docker = dependencies.createDockerClient();
        const runConfig = await loadRunConfig(loaded.config, options.runId);
        await invokeDockerWorkerAction({
          projectConfig: loaded.config,
          runConfig,
          runId: options.runId,
          docker,
          backend: dependencies.createBackend(),
          action: "confirm_plan",
          body: { feedback: options.feedback },
        });
        if (options.advance) {
          await invokeDockerWorkerAction({
            projectConfig: loaded.config,
            runConfig,
            runId: options.runId,
            docker,
            backend: dependencies.createBackend(),
            action: "advance",
          });
        }
        const control = await openHostControl(
          options.config,
          options.runId,
          () => dependencies.createBackend("unused"),
          { validateWorkspace: false },
        );
        printState(await control.status(options.runId));
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
        const docker = dependencies.createDockerClient();
        const runConfig = await loadRunConfig(loaded.config, options.runId);
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
        await invokeDockerWorkerAction({
          projectConfig: loaded.config,
          runConfig,
          runId: options.runId,
          docker,
          backend: dependencies.createBackend(),
          action: "confirm_verification",
          body: {
            keepCurrent: options.keepCurrent,
            patch,
            persistProjectDefaults: options.persistProjectDefaults,
          },
        });
        if (options.advance) {
          await invokeDockerWorkerAction({
            projectConfig: loaded.config,
            runConfig: await loadRunConfig(loaded.config, options.runId),
            runId: options.runId,
            docker,
            backend: dependencies.createBackend(),
            action: "advance",
          });
        }
        const control = await openHostControl(
          options.config,
          options.runId,
          () => dependencies.createBackend("unused"),
          { validateWorkspace: false },
        );
        printState(await control.status(options.runId));
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
        const docker = dependencies.createDockerClient();
        if (options.persistProjectDefaults && !options.verificationCommand) {
          throw new Error("--persist-project-defaults requires --verification-command");
        }
        await invokeDockerWorkerAction({
          projectConfig: loaded.config,
          runConfig: await loadRunConfig(loaded.config, options.runId),
          runId: options.runId,
          docker,
          backend: dependencies.createBackend(),
          action: "retry_verification_baseline",
          body: {
            verificationCommand: options.verificationCommand,
            persistProjectDefaults: options.persistProjectDefaults,
          },
        });
        const control = await openHostControl(
          options.config,
          options.runId,
          () => dependencies.createBackend("unused"),
          { validateWorkspace: false },
        );
        let state = await control.status(options.runId);
        if (options.advance && !state.verificationBaselineReady) {
          await invokeDockerWorkerAction({
            projectConfig: loaded.config,
            runConfig: await loadRunConfig(loaded.config, options.runId),
            runId: options.runId,
            docker,
            backend: dependencies.createBackend(),
            action: "advance",
          });
          state = await control.status(options.runId);
        }
        printState(state);
      },
    );

  program
    .command("retry")
    .description("Explicitly retry a bounded step after inspecting a blocked run")
    .requiredOption("--run-id <id>", "run id")
    .option("--config <path>", "config path")
    .option("--project <project-key>", "external project key")
    .option("--repository <path>", "registered repository path")
    .option("--home <path>", "harness home override")
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
      project?: string;
      repository?: string;
      home?: string;
      force: boolean;
      maxRunTokens?: number;
      maxRunCostUsd?: number;
      commitDirty?: string | boolean;
      acceptTree: boolean;
    }) => {
      const opened = await openResolvedHostControl(
        options,
        dependencies,
        { allowMissingWorkspace: true },
      );
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
        await invokeDockerWorkerAction({
          projectConfig: opened.projectConfig,
          runConfig: opened.config,
          runId: options.runId,
          docker: opened.docker,
          backend: dependencies.createBackend(),
          action: "accept_tree",
        });
      } else if (options.commitDirty) {
        throw new Error(
          "Preflight commit-order controls have been removed. " +
            "Docker workspaces start from the committed base and never import control-checkout dirt.",
        );
      } else {
        await invokeDockerWorkerAction({
          projectConfig: opened.projectConfig,
          runConfig: opened.config,
          runId: options.runId,
          docker: opened.docker,
          backend: dependencies.createBackend(),
          action: "retry",
          body: {
            force: options.force,
            maxRunTokens: options.maxRunTokens,
            maxRunCostUsd: options.maxRunCostUsd,
          },
        });
      }
      const resolved = await resolvedProjectConfig(options);
      let state!: RunState;
      await withCliControlServer(
        opened.projectConfig,
        resolved.path,
        dependencies,
        async (server) => {
          await server.runLifecycle.enqueue(options.runId);
          state = await server.runLifecycle.productState(options.runId);
        },
      );
      printState(state);
    });

  program
    .command("status")
    .description("Show persisted run state")
    .requiredOption("--run-id <id>", "run id")
    .option("--config <path>", "config path")
    .option("--project <project-key>", "external project key")
    .option("--repository <path>", "registered repository path")
    .option("--home <path>", "harness home override")
    .option("--json", "print the full state", false)
    .action(async (options: RunCommandOptions & { json: boolean }) => {
      const opened = await openResolvedHostControl(
        options,
        {
          ...dependencies,
          createBackend: () => dependencies.createBackend("unused"),
        },
        { validateWorkspace: false, allowMissingWorkspace: true },
      );
      const control = opened.control;
      const state = await control.status(options.runId);
      if (options.json) {
        const usage = await aggregateSessionUsage(control, options.runId);
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
      const control = await openHostControl(
        options.config,
        options.runId,
        () => dependencies.createBackend("unused"),
        { validateWorkspace: false },
      );
      const result = await control.cancel(options.runId);
      if (result.pending) {
        console.log(`Cancellation pending for ${options.runId}; the advancing process will finish it.`);
      }
      printState(result.state);
    });

  program
    .command("cleanup")
    .description(
      "Remove a settled Docker workspace after conservative safety checks",
    )
    .requiredOption("--run-id <id>", "run id")
    .option("--config <path>", "config path")
    .option(
      "--discard",
      "explicitly discard unpublished commits not reachable from a retained named ref / import",
      false,
    )
    .action(async (options: { runId: string; config?: string; discard: boolean }) => {
      const control = await openHostControl(
        options.config,
        options.runId,
        () => dependencies.createBackend("unused"),
        { validateWorkspace: false },
      );
      const result = await control.cleanup(options.runId, { discard: options.discard });
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
      if (status.cursorCredential) {
        console.log(
          status.cursorCredential.passed
            ? "Cursor credential custody: host proxy; key not delivered to worker."
            : `Cursor provider: blocked — ${status.cursorCredential.reason}`,
        );
      }
    });

  execution
    .command("cursor-provider-smoke")
    .description("Run the fail-closed host Cursor provider-proxy proof preflight")
    .requiredOption("--repository <path>", "registered project repository")
    .option("--force", "ignore matching cached evidence", false)
    .option("--json", "print a redacted status object", false)
    .action(
      async (options: { repository: string; force: boolean; json: boolean }) => {
        const apiKey = process.env.CURSOR_API_KEY?.trim();
        if (!apiKey) {
          throw new Error(
            "Host Cursor credential is not configured. Set CURSOR_API_KEY in this PowerShell session only; never pass it as an argument or paste it into chat.",
          );
        }
        const loaded = await resolvedProjectConfig({ repository: options.repository });
        const imageDigest = loaded.config.execution.docker.workerImageDigest?.trim();
        if (!imageDigest) {
          throw new Error(
            "No maintained worker image digest is configured. Run `agent-harness execution prepare-worker --repository <path> --force-rebuild --write-settings` first.",
          );
        }
        const {
          cursorProviderProofCacheKey,
          currentCursorProviderProofTuple,
          findMatchingCursorProviderProof,
          loadCursorProviderProofCache,
        } = await import("../application/cursor-provider-proof.js");
        const { resolveHarnessPaths } = await import("../application/paths.js");
        const { ensureCursorProviderTlsMaterial } = await import(
          "../infrastructure/provider-proxy/tls.js"
        );
        const paths = resolveHarnessPaths(loaded.config);
        const tls = await ensureCursorProviderTlsMaterial(
          path.join(paths.stateRoot, "cursor-provider-tls"),
        );
        const tuple = currentCursorProviderProofTuple({
          imageDigest,
          model: loaded.config.models.capable,
          tlsIdentity: tls.tlsIdentity,
          apiKey,
        });
        const cached = options.force
          ? undefined
          : findMatchingCursorProviderProof(
              await loadCursorProviderProofCache(paths.stateRoot),
              tuple,
            );
        const report =
          cached ??
          (await (
            await import("../application/cursor-provider-contract-recorder.js")
          ).recordLiveCursorProviderContract({
            apiKey,
            projectStateRoot: paths.stateRoot,
            tuple,
            tls,
            docker: dependencies.createDockerClient(),
            dockerPolicy: loaded.config.execution.docker,
          }));
        const ok = report.ok && !report.unsupported;
        const payload = {
          ok,
          unsupported: report.unsupported,
          custody: "host-proxy",
          keyDeliveredToWorker: false,
          proofIdentity: cursorProviderProofCacheKey(tuple).slice(0, 16),
          imageDigest,
          sdkVersion: tuple.sdkVersion,
          providerProtocolVersion: tuple.providerProtocolVersion,
          contractVersion: tuple.contractVersion,
          proxyVersion: tuple.proxyVersion,
          model: tuple.model,
          tlsIdentity: tuple.tlsIdentity,
          provedAt: report.provedAt,
          checks: report.checks,
          operations: report.operations,
          lifecycle: report.lifecycle,
          credentialAbsence: report.credentialAbsence,
          sdkDiagnostics: report.sdkDiagnostics,
          lifecycleStages: report.lifecycleStages,
          reason: report.reason,
          next: ok ? undefined : "Resolve the reported TLS/auth/SDK failure and rerun with --force.",
        };
        if (options.json) console.log(JSON.stringify(payload, null, 2));
        else {
          console.log("Cursor credential custody: host proxy; key not delivered to worker.");
          console.log(
            `Provider proxy proof: ${payload.ok ? "PASSED" : "BLOCKED"} (${payload.proofIdentity})`,
          );
          for (const check of payload.checks) {
            console.log(`- ${check.ok ? "PASS" : "FAIL"} ${check.id}: ${check.detail}`);
          }
          if (payload.reason) console.log(`Reason: ${payload.reason}`);
        }
        if (!payload.ok) process.exitCode = 2;
      },
    );

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
        // --force-rebuild must build from docker/worker/Dockerfile. Do not fall back to
        // the configured digest pin (that path only pull/reuses and never rebuilds).
        const pullImage = options.forceRebuild
          ? options.image?.trim() || undefined
          : options.image?.trim() || configuredWorker || undefined;
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
          });
          settingsWritten = true;
          // External project files are sparse overrides. Reload them through the
          // registry/home merge path or repositoryRoot "." and the shared base
          // catalog are incorrectly resolved relative to the state directory.
          const reloaded = options.repository
            ? await resolvedProjectConfig({ repository: options.repository })
            : await loadConfig(configPath);
          config = reloaded.config;
        }

        const statusConfig = {
          ...config,
          execution: {
            ...config.execution,
            docker: {
              ...config.execution.docker,
              workerImageDigest: prepared.workerImageDigest,
            },
          },
        };

        const { resolveHarnessPaths } = await import("../application/paths.js");
        const projectPaths = resolveHarnessPaths(statusConfig);

        // Preparing an image is only complete when its digest also has a passing
        // isolation probe: run creation and `execution status` both read that cache.
        let probe:
          | import("../application/sandbox-isolation-probe.js").SandboxIsolationProbeReport
          | undefined;
        if (statusConfig.execution.docker.sandboxRequired !== false) {
          const { ensureSandboxIsolationProbe } = await import(
            "../application/sandbox-isolation-probe.js"
          );
          const { mkdtemp, rm } = await import("node:fs/promises");
          const { tmpdir } = await import("node:os");
          const probeHostPath = await mkdtemp(path.join(tmpdir(), "agent-harness-probe-"));
          try {
            probe = await ensureSandboxIsolationProbe({
              imageDigest: prepared.workerImageDigest,
              docker: createDockerClient(),
              dockerPolicy: statusConfig.execution.docker,
              projectStateRoot: projectPaths.stateRoot,
              probeRunStateHostPath: probeHostPath,
            });
          } finally {
            await rm(probeHostPath, { recursive: true, force: true }).catch(() => undefined);
          }
        }

        const status = await evaluateExecutionRuntimeStatus({
          config: statusConfig,
          docker: createDockerClient(),
          repositoryRoot: projectPaths.controlRoot,
          projectStateRoot: projectPaths.stateRoot,
          imageDigest: prepared.workerImageDigest,
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
          configPath,
          sandboxIsolationProbe: probe
            ? {
                ok: probe.ok,
                unsupported: probe.unsupported,
                reason: probe.reason,
                checks: probe.checks,
              }
            : undefined,
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
            console.log(`Wrote project settings: ${configPath}`);
          }
          if (probe) {
            console.log(`Sandbox isolation probe ok=${probe.ok}`);
            if (!probe.ok) {
              if (probe.reason) console.log(`  reason: ${probe.reason}`);
              for (const check of probe.checks.filter((entry) => !entry.ok)) {
                console.log(`  - ${check.id}: ${check.detail}`);
              }
            }
          }
          console.log(`Execution status ready=${status.ready} (runtime=${status.runtime})`);
          for (const blocker of status.blockers) {
            console.log(`- ${blocker.code}: ${blocker.message}`);
            if (blocker.remediation) console.log(`  remediation: ${blocker.remediation}`);
          }
        }

        if (!prepared.readiness.ready || (probe && !probe.ok)) {
          process.exitCode = 1;
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
      const workspace = await loadRunWorkspace(config, options.runId).catch(() => undefined);
      const docker = createDockerClient();
      const workerHealth =
        workspace?.kind === "host-worktree"
          ? { ok: true, detail: "Worker sandboxes are disposable; host worktree and run state remain." }
          : undefined;
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
    .command("recover-container")
    .description("No-op: worker sandboxes are disposable; host worktree and run state remain")
    .requiredOption("--run-id <id>", "run id")
    .option("--config <path>", "config path")
    .action(async (options: { runId: string; config?: string }) => {
      const { config } = await loadConfig(options.config);
      const { loadRunWorkspace } = await import("../config/io.js");
      const workspace = await loadRunWorkspace(config, options.runId).catch(() => undefined);
      console.log(
        JSON.stringify(
          {
            runId: options.runId,
            workspaceKind: workspace?.kind ?? "missing",
            disposable: true,
            detail:
              "Containers are created per bounded exec and destroyed afterward. Recreate a sandbox instead of recovering a long-lived worker.",
          },
          null,
          2,
        ),
      );
    });

  execution
    .command("reconcile-orphans")
    .description(
      "Inspect harness-labeled containers; prune disposable ah-probe volumes; optionally remove orphan containers",
    )
    .option("--config <path>", "config path")
    .option("--apply", "remove containers that pass age/state checks (never workspace volumes)", false)
    .option("--json", "print JSON", false)
    .action(async (options: { config?: string; apply: boolean; json: boolean }) => {
      const { config } = await loadConfig(options.config);
      const { createDockerClient } = await import("../infrastructure/container/docker-client.js");
      const { reconcileOrphanContainers } = await import("../application/orphan-reconciler.js");
      const report = await reconcileOrphanContainers({
        docker: createDockerClient(),
        knownRuns: [],
        apply: options.apply,
      });
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log(
        `Inspected ${report.inspected} managed container(s); removed ${report.removed.length}. ` +
          `Probe volumes: found ${report.probeVolumes.found.length}, removed ${report.probeVolumes.removed.length}.`,
      );
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
      const control = await openHostControl(
        options.config,
        options.runId,
        () => dependencies.createBackend("unused"),
        { validateWorkspace: false },
      );
      const store = control.store as OperatorRunRepository;
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
    .description("Prove workspace write + absence of host state mounts (internal)")
    .requiredOption("--workspace <path>", "writable workspace root", "/workspace")
    .requiredOption("--run-state <path>", "host-state path that must be absent", "/host-state")
    .requiredOption("--rpc-secret <path>", "bootstrap secret path that must be unreadable")
    .action(
      async (options: { workspace: string; runState: string; rpcSecret: string }) => {
        const { access, readFile, writeFile } = await import("node:fs/promises");
        const pathMod = await import("node:path");
        const { evaluateSandboxIsolationSelfCheck } = await import(
          "../application/sandbox-isolation-probe.js"
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

        // Host state must not exist even for the unsandboxed worker process.
        let mountVisibleToUnsandboxed = false;
        try {
          await access(options.runState);
          mountVisibleToUnsandboxed = true;
        } catch {
          mountVisibleToUnsandboxed = false;
        }

        // Attempt a real write; an absent host-state path must not be creatable
        // under the read-only container root.
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

        let secretPresent = false;
        try {
          await access(options.rpcSecret);
          secretPresent = true;
        } catch {
          secretPresent = false;
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
          canReadRunState: mountVisibleToUnsandboxed,
          canWriteRunState: unsandboxedWroteRunState,
          secretPresent,
          canReadRpcSecret: unsandboxedReadSecret,
          // Provider sandbox behavior is verified separately by the Cursor probe.
          canAccessOutsideWorkspace: false,
        });

        const payload = {
          ...evaluated,
          mountVisibleToUnsandboxed,
          unsandboxedWroteRunState,
          secretPresent,
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
    .requiredOption("--worker-instance-id <id>", "worker instance id")
    .requiredOption("--state-endpoint <url>", "host broker endpoint")
    .option("--listen <host:port>", "bind address", "0.0.0.0:8787")
    .action(
      async (options: {
        runId: string;
        workerInstanceId: string;
        stateEndpoint: string;
        listen: string;
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
          workerInstanceId: options.workerInstanceId,
          stateEndpoint: options.stateEndpoint,
          host,
          port,
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

async function withCliControlServer<T>(
  config: HarnessConfig,
  configPath: string,
  dependencies: CliDependencies,
  work: (server: UiServer) => Promise<T>,
): Promise<T> {
  const server = await dependencies.startUiServer({
    config,
    configPath,
    backend: dependencies.createBackend(),
    docker: dependencies.createDockerClient(),
    port: 0,
    openBrowser: false,
    dashboard: false,
  });
  try {
    return await work(server);
  } finally {
    await server.close();
  }
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
  if (next.git.enabled || baseBranch != null) {
    const resolvedBaseBranch = await resolveRunBaseBranch(next, baseBranch);
    next = { ...next, git: { ...next.git, baseBranch: resolvedBaseBranch } };
  }
  return next;
}

type RunCommandOptions = {
  runId: string;
  config?: string;
  project?: string;
  repository?: string;
  home?: string;
};

async function openResolvedHostControl(
  options: RunCommandOptions,
  dependencies: CliDependencies,
  openOptions: OpenRunHarnessOptions = {},
) {
  const resolved = await resolvedProjectConfig(options);
  const docker = dependencies.createDockerClient();
  const opened = await openHostRunControl(
    resolved.config,
    options.runId,
    {
      backend: dependencies.createBackend(),
      docker,
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
            },
          }
        : {}),
    },
    openOptions,
  );
  return {
    ...opened,
    projectConfig: resolved.config,
    projectKey: resolved.lookup?.registration.projectKey,
    docker,
  };
}

async function runConfig(configPath: string | undefined, runId: string): Promise<HarnessConfig> {
  const { config } = await loadConfig(configPath);
  return loadRunConfig(config, runId);
}

async function openHostControl(
  configPath: string | undefined,
  runId: string,
  createBackend: CliDependencies["createBackend"],
  options?: OpenRunHarnessOptions,
): Promise<HostRunControl> {
  const { config } = await loadConfig(configPath);
  const opened = await openHostRunControl(
    config,
    runId,
    { backend: createBackend() },
    options,
  );
  return opened.control;
}

async function invokeDockerWorkerAction(input: {
  projectConfig: HarnessConfig;
  runConfig: HarnessConfig;
  runId: string;
  docker: DockerClient;
  action: string;
  body?: Record<string, unknown>;
  backend?: import("../infrastructure/agents/types.js").AgentBackend;
}): Promise<unknown> {
  const backend = input.backend ?? (await import("../infrastructure/agents/fake-backend.js")).createFakeBackend({});
  const opened = await openHostRunControl(input.projectConfig, input.runId, {
    backend,
    docker: input.docker,
  });
  const { openWorkerRunRuntime } = await import("../application/run-engine-factory.js");
  const { HostRunLifecycleOwner } = await import("../vnext/plugins/host-run-lifecycle.js");
  const lifecycle = new HostRunLifecycleOwner({
    store: opened.control.store,
    runtimeDependencies: { backend, docker: input.docker },
    loadRunConfig: async () => input.runConfig,
    startWorker: async () => undefined,
  });
  return dispatchHostRunAction({
    action: input.action,
    runId: input.runId,
    body: input.body ?? {},
    control: opened.control,
    runLifecycle: lifecycle,
    openEngine: async () =>
      (
        await openWorkerRunRuntime(input.projectConfig, input.runId, {
          backend,
          docker: input.docker,
        })
      ).engine,
  });
}

async function aggregateSessionUsage(
  control: HostRunControl,
  runId: string,
): Promise<{
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  sessions: number;
}> {
  const files = (await control.store.listFiles(runId, "sessions")).filter((file) =>
    file.endsWith(".json"),
  );
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  for (const file of files) {
    const session = (await control.store.readJson(runId, file)) as {
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

function printState(state: RunState): void {
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

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

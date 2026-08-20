#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { bootHost } from "./boot.js";
import { dumpHostConfig } from "./dump-config.js";
import { defaultHarnessHome, projectKeyFor } from "./home.js";

export function createCli(): Command {
  const program = new Command();
  program
    .name("agent-harness")
    .description("Durable idea-to-feature orchestration")
    .option("--home <path>", "harness home override", process.env.AGENT_HARNESS_HOME);

  program
    .command("dump-config")
    .description("Render and validate the resolved host profile without starting Docker")
    .action(async () => {
      const home = program.opts<{ home?: string }>().home ?? defaultHarnessHome();
      process.stdout.write(`${await dumpHostConfig({ home })}\n`);
    });

  program
    .command("project")
    .description("Register and inspect target repositories")
    .addCommand(
      new Command("add")
        .requiredOption("--repository <path>", "target repository (control root)")
        .action(async (options: { repository: string }) => {
          const home = program.opts<{ home?: string }>().home ?? defaultHarnessHome();
          const booted = await bootHost({ home });
          try {
            const registration = await booted.ctx.projects.add(options.repository);
            process.stdout.write(`${JSON.stringify(registration, null, 2)}\n`);
          } finally {
            await booted.dispose();
          }
        }),
    )
    .addCommand(
      new Command("list").action(async () => {
        const home = program.opts<{ home?: string }>().home ?? defaultHarnessHome();
        const booted = await bootHost({ home });
        try {
          const projects = await booted.ctx.projects.list();
          process.stdout.write(`${JSON.stringify(projects, null, 2)}\n`);
        } finally {
          await booted.dispose();
        }
      }),
    );

  program
    .command("start")
    .alias("run")
    .description("Start a run from an idea")
    .requiredOption("--idea <text>", "idea text, or @path to read a file")
    .option("--repository <path>", "registered control root")
    .option("--project <key>", "registered project key")
    .option("--workflow <id>", "workflow bundle id", "default")
    .action(async (options: {
      idea: string;
      repository?: string;
      project?: string;
      workflow: string;
    }) => {
      const home = program.opts<{ home?: string }>().home ?? defaultHarnessHome();
      const idea = await resolveIdea(options.idea);
      const booted = await bootHost({ home });
      try {
        const run = await booted.ctx.runLifecycle.start({
          idea,
          repository: options.repository,
          projectKey: options.project,
          workflowBundleId: options.workflow,
        });
        process.stdout.write(`${JSON.stringify(summarize(run), null, 2)}\n`);
      } finally {
        await booted.dispose();
      }
    });

  for (const verb of ["continue", "retry", "cancel", "status"] as const) {
    program
      .command(verb)
      .requiredOption("--run-id <id>", "run id")
      .action(async (options: { runId: string }) => {
        const home = program.opts<{ home?: string }>().home ?? defaultHarnessHome();
        const booted = await bootHost({ home });
        try {
          const run = await booted.ctx.runLifecycle[verb](options.runId);
          process.stdout.write(`${JSON.stringify(summarize(run), null, 2)}\n`);
        } finally {
          await booted.dispose();
        }
      });
  }

  program
    .command("delete")
    .description("Delete a run, its sandbox, worktree, and stored artifacts")
    .requiredOption("--run-id <id>", "run id")
    .action(async (options: { runId: string }) => {
      const home = program.opts<{ home?: string }>().home ?? defaultHarnessHome();
      const booted = await bootHost({ home });
      try {
        const result = await booted.ctx.runLifecycle.delete(options.runId);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } finally {
        await booted.dispose();
      }
    });

  program
    .command("answer")
    .requiredOption("--run-id <id>", "run id")
    .option("--answers <json>", "JSON object of question id → answer")
    .option("--notes <text>", "operator notes")
    .action(async (options: { runId: string; answers?: string; notes?: string }) => {
      const home = program.opts<{ home?: string }>().home ?? defaultHarnessHome();
      const booted = await bootHost({ home });
      try {
        const answers = options.answers ? (JSON.parse(options.answers) as Record<string, string>) : {};
        const run = await booted.ctx.runLifecycle.answer(options.runId, {
          answers,
          notes: options.notes,
        });
        process.stdout.write(`${JSON.stringify(summarize(run), null, 2)}\n`);
      } finally {
        await booted.dispose();
      }
    });

  program
    .command("ui")
    .description("Open the authenticated loopback dashboard")
    .option("--port <n>", "port", "8787")
    .option("--repository <path>", "register or select a control root")
    .option("--no-open", "do not open a browser")
    .action(async (options: { port: string; open: boolean; repository?: string }) => {
      const home = program.opts<{ home?: string }>().home ?? defaultHarnessHome();
      const { dashboardRow } = await import("./plugins/dashboard.js");
      const booted = await bootHost({
        home,
        extraRows: [
          ...(await import("./plugins/profile.js")).hostRuntimeRows(),
          dashboardRow({ port: Number(options.port) }),
        ],
      });
      if (options.repository) await booted.ctx.projects.add(options.repository);
      const dashboard = booted.ctx.dashboard;
      if (!dashboard) throw new Error("Dashboard plugin did not activate");
      const url = await dashboard.start();
      process.stdout.write(`${url}\n`);
      if (options.open) {
        const { default: opener } = await import("node:child_process");
        if (process.platform === "win32") {
          // `start` is a cmd builtin; quote the empty title so URLs with ? are not mangled.
          opener.spawn(`start "" "${url}"`, { shell: true, detached: true, stdio: "ignore" }).unref();
        } else {
          const command = process.platform === "darwin" ? "open" : "xdg-open";
          opener.spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
        }
      }
      await new Promise<void>((resolve) => {
        const shutdown = () => {
          void dashboard.stop().finally(() => {
            void booted.dispose().finally(() => resolve());
          });
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
    });

  return program;
}

async function resolveIdea(idea: string): Promise<string> {
  if (!idea.startsWith("@")) return idea;
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  return (await readFile(resolve(idea.slice(1)), "utf8")).trim();
}

function summarize(run: {
  identity: { runId: string; projectKey: string };
  state: { status: string; phase: string };
}) {
  return {
    runId: run.identity.runId,
    status: run.state.status,
    phase: run.state.phase,
    projectKey: run.identity.projectKey,
  };
}

export async function main(argv = process.argv): Promise<void> {
  await createCli().parseAsync(argv);
}

function isCliEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return path.resolve(entry) === path.resolve(self);
  }
}

if (isCliEntry()) {
  void main();
}

export { projectKeyFor };

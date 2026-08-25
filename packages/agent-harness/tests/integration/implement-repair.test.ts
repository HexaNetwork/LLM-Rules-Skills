import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { WorkflowBundle, WorkPacket } from "../../src/domain/types.js";
import type { BootedHost } from "../../src/boot.js";
import { bootTestHost, createTempRepo, currentBranch } from "../helpers.js";

const exec = promisify(execFile);

// cmd /c mangles nested quotes when the inline script contains spaces, so
// failing commands live in committed script files and stay quote-free.
const PASS = `node -e "process.exit(0)"`;
const PROJECT_FAIL = "node fail-project.js";
const ENV_FAIL = "node fail-env.js";

const TICKET: WorkflowBundle = { id: "ticket", phases: ["implement", "scenario-test", "publish"] };
const REVIEW_ONLY: WorkflowBundle = { id: "review-only", phases: ["implement", "final-review", "publish"] };

type Recorder = {
  inputs: unknown[];
  reply: (role: string, packet: WorkPacket) => unknown;
};

function recorder(reply: (input: Record<string, unknown>, calls: number) => unknown): Recorder {
  const inputs: unknown[] = [];
  return {
    inputs,
    reply: (_role, packet) => {
      inputs.push(packet.input);
      return reply((packet.input ?? {}) as Record<string, unknown>, inputs.length);
    },
  };
}

function lastInput(calls: Recorder): Record<string, unknown> {
  return (calls.inputs[calls.inputs.length - 1] ?? {}) as Record<string, unknown>;
}

async function commitScript(repo: string, name: string, body: string): Promise<void> {
  await writeFile(path.join(repo, name), body, "utf8");
  await exec("git", ["add", name], { cwd: repo, windowsHide: true });
  await exec("git", ["commit", "-m", `add ${name}`], { cwd: repo, windowsHide: true });
}

describe("implement phase repair loop", () => {
  it("resumes a rejected task on retry with the review feedback", async () => {
    const repo = await createTempRepo();
    const implementer = recorder(() => ({ summary: "done", files: [] }));
    const reviewer = recorder((_input, calls) =>
      calls === 1
        ? { verdict: "reject", summary: "Missing validation" }
        : { verdict: "approve", summary: "ok" },
    );
    const { host } = await bootTestHost({
      bundles: [TICKET],
      agents: { mode: "fake", scripted: { implementer: implementer.reply, "task-reviewer": reviewer.reply } },
    });
    try {
      const project = await host.ctx.projects.add(repo);
      const blocked = await host.ctx.runLifecycle.start({
        idea: "Add a status endpoint",
        projectKey: project.projectKey,
        baseBranch: await currentBranch(repo),
        workflowBundleId: "ticket",
      });
      expect(blocked.state.phase).toBe("implement");
      expect(blocked.state.status).toBe("blocked");
      expect(blocked.state.block?.retriable).toBe(true);
      const task = blocked.state.tasks[0]!;
      expect(task.status).toBe("in_progress");
      expect(task.reviewSummary).toBe("Missing validation");
      expect(task.attempts).toEqual({ implementation: 1, review: 1 });
      expect(implementer.inputs).toHaveLength(1);

      const run = await host.ctx.runLifecycle.retry(blocked.identity.runId);
      expect(run.state.status).toBe("completed");
      expect(implementer.inputs).toHaveLength(2);
      expect(lastInput(implementer).reviewFeedback).toBe("Missing validation");
      const done = run.state.tasks[0]!;
      expect(done.status).toBe("committed");
      expect(done.reviewSummary).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });

  it("runs harness verification before review and stores the evidence on the task", async () => {
    const repo = await createTempRepo();
    const order: string[] = [];
    const reviewer = recorder(() => {
      order.push("review");
      return { verdict: "approve", summary: "ok" };
    });
    const { host } = await bootTestHost({
      bundles: [TICKET],
      agents: { mode: "fake", scripted: { "task-reviewer": reviewer.reply } },
    });
    try {
      const project = await host.ctx.projects.add(repo);
      await host.ctx.store.writeProjectSettings(project.projectKey, {
        verification: { command: PASS },
      });
      const verify = host.ctx.commands.verify.bind(host.ctx.commands);
      host.ctx.commands.verify = async (runId, command) => {
        order.push("verify");
        return verify(runId, command);
      };
      const run = await host.ctx.runLifecycle.start({
        idea: "Add a status endpoint",
        projectKey: project.projectKey,
        baseBranch: await currentBranch(repo),
        workflowBundleId: "ticket",
      });
      expect(run.state.status).toBe("completed");
      // Per-task verification precedes the review; scenario-test verifies again at the end.
      expect(order).toEqual(["verify", "review", "verify"]);
      const task = run.state.tasks[0]!;
      expect(task.status).toBe("committed");
      expect(task.verification?.passed).toBe(true);
      expect(task.verification?.classification).toBe("passed");
      expect(task.verification?.command).toBe(PASS);
      const reviewInput = lastInput(reviewer);
      expect((reviewInput.verification as { passed?: boolean } | undefined)?.passed).toBe(true);
    } finally {
      await host.dispose();
    }
  });

  it("routes a verification project failure back to the implementer", async () => {
    const repo = await createTempRepo();
    await commitScript(repo, "fail-project.js", `console.error("1 test failed");\nprocess.exit(1);\n`);
    const implementer = recorder(() => ({ summary: "done", files: [] }));
    const reviewer = recorder(() => ({ verdict: "approve", summary: "ok" }));
    const { host } = await bootTestHost({
      bundles: [TICKET],
      agents: { mode: "fake", scripted: { implementer: implementer.reply, "task-reviewer": reviewer.reply } },
    });
    try {
      const project = await host.ctx.projects.add(repo);
      await host.ctx.store.writeProjectSettings(project.projectKey, {
        verification: { command: PROJECT_FAIL },
      });
      const blocked = await host.ctx.runLifecycle.start({
        idea: "Add a status endpoint",
        projectKey: project.projectKey,
        baseBranch: await currentBranch(repo),
        workflowBundleId: "ticket",
      });
      expect(blocked.state.status).toBe("blocked");
      const task = blocked.state.tasks[0]!;
      expect(task.status).toBe("in_progress");
      expect(task.verification?.classification).toBe("project_failure");
      expect(task.attempts?.implementation).toBe(1);
      expect(reviewer.inputs).toHaveLength(0);

      await host.ctx.store.writeProjectSettings(project.projectKey, {
        verification: { command: PASS },
      });
      const run = await host.ctx.runLifecycle.retry(blocked.identity.runId);
      expect(run.state.status).toBe("completed");
      expect(implementer.inputs).toHaveLength(2);
      const repair = lastInput(implementer);
      expect(String((repair.verification as { output?: string } | undefined)?.output)).toContain(
        "1 test failed",
      );
    } finally {
      await host.dispose();
    }
  });

  it("blocks on an environment failure without re-invoking the implementer", async () => {
    const repo = await createTempRepo();
    await commitScript(repo, "fail-env.js", `console.error("could not find java");\nprocess.exit(1);\n`);
    const implementer = recorder(() => ({ summary: "done", files: [] }));
    const reviewer = recorder(() => ({ verdict: "approve", summary: "ok" }));
    const { host } = await bootTestHost({
      bundles: [TICKET],
      agents: { mode: "fake", scripted: { implementer: implementer.reply, "task-reviewer": reviewer.reply } },
    });
    try {
      const project = await host.ctx.projects.add(repo);
      await host.ctx.store.writeProjectSettings(project.projectKey, {
        verification: { command: ENV_FAIL },
      });
      const blocked = await host.ctx.runLifecycle.start({
        idea: "Add a status endpoint",
        projectKey: project.projectKey,
        baseBranch: await currentBranch(repo),
        workflowBundleId: "ticket",
      });
      expect(blocked.state.status).toBe("blocked");
      expect(blocked.state.block?.reason).toMatch(/environment failure/i);
      expect(blocked.state.block?.reason).toContain("docker/worker/Dockerfile");
      const task = blocked.state.tasks[0]!;
      expect(task.verification?.classification).toBe("environment_failure");
      expect(implementer.inputs).toHaveLength(1);
      expect(reviewer.inputs).toHaveLength(0);

      await host.ctx.store.writeProjectSettings(project.projectKey, {
        verification: { command: PASS },
      });
      const run = await host.ctx.runLifecycle.retry(blocked.identity.runId);
      expect(run.state.status).toBe("completed");
      expect(implementer.inputs).toHaveLength(1);
      expect(reviewer.inputs).toHaveLength(1);
      expect(run.state.tasks[0]!.status).toBe("committed");
    } finally {
      await host.dispose();
    }
  });

  it("blocks the task after exhausting implementation attempts", async () => {
    const repo = await createTempRepo();
    const implementer = recorder(() => ({ summary: "done", files: [] }));
    const reviewer = recorder(() => ({ verdict: "reject", summary: "still wrong" }));
    const { host } = await bootTestHost({
      bundles: [TICKET],
      agents: { mode: "fake", scripted: { implementer: implementer.reply, "task-reviewer": reviewer.reply } },
    });
    try {
      const project = await host.ctx.projects.add(repo);
      await host.ctx.store.writeProjectSettings(project.projectKey, {
        workflow: { maxImplementationAttempts: 2 },
      });
      const first = await host.ctx.runLifecycle.start({
        idea: "Add a status endpoint",
        projectKey: project.projectKey,
        baseBranch: await currentBranch(repo),
        workflowBundleId: "ticket",
      });
      expect(first.state.status).toBe("blocked");
      expect(first.state.tasks[0]!.status).toBe("in_progress");

      const exhausted = await host.ctx.runLifecycle.retry(first.identity.runId);
      expect(exhausted.state.status).toBe("blocked");
      expect(exhausted.state.block?.reason).toMatch(/after 2 implementation attempts/);
      const task = exhausted.state.tasks[0]!;
      expect(task.status).toBe("blocked");
      expect(task.attempts?.implementation).toBe(2);
      expect(implementer.inputs).toHaveLength(2);
    } finally {
      await host.dispose();
    }
  });
});

describe("worker image repair", () => {
  const imageFixerReply = (_role: string, packet: WorkPacket) => ({
    summary: "installed tool",
    dockerfile:
      String((packet.input as { dockerfile?: string } | undefined)?.dockerfile ?? "") +
      "\nRUN echo repaired\n",
  });

  function stubDockerSandbox(host: BootedHost): void {
    const sandbox = host.ctx.sandbox as {
      mode: string;
      buildImage: (dockerfilePath: string, tag: string) => Promise<string>;
      destroy: (runId: string, options?: { purgeImage?: boolean }) => Promise<void>;
    };
    sandbox.mode = "docker";
    sandbox.buildImage = async () => "built";
    sandbox.destroy = async () => undefined;
  }

  // The docker stub only flips the mode flag, so the real verify would split the
  // command for `sh`, which does not exist on Windows. Drop to "none" for the
  // duration of the real call so it runs through the local shell instead.
  function patchVerify(host: BootedHost, behavior: (calls: number) => "real" | "pass"): void {
    const sandbox = host.ctx.sandbox as { mode: string };
    const verify = host.ctx.commands.verify.bind(host.ctx.commands);
    let calls = 0;
    host.ctx.commands.verify = async (runId, command) => {
      calls += 1;
      if (behavior(calls) === "pass") {
        return { command: command ?? "", passed: true, output: "ok", classification: "passed" };
      }
      sandbox.mode = "none";
      try {
        return await verify(runId, command);
      } finally {
        sandbox.mode = "docker";
      }
    };
  }

  it("auto-repairs the run image and completes the run", async () => {
    const repo = await createTempRepo();
    await commitScript(repo, "fail-env.js", `console.error("could not find java");\nprocess.exit(1);\n`);
    const implementer = recorder(() => ({ summary: "done", files: [] }));
    const reviewer = recorder(() => ({ verdict: "approve", summary: "ok" }));
    const { host } = await bootTestHost({
      bundles: [TICKET],
      agents: {
        mode: "fake",
        scripted: {
          implementer: implementer.reply,
          "task-reviewer": reviewer.reply,
          "image-fixer": imageFixerReply,
        },
      },
    });
    try {
      stubDockerSandbox(host);
      patchVerify(host, (calls) => (calls === 1 ? "real" : "pass"));
      const project = await host.ctx.projects.add(repo);
      await host.ctx.store.writeProjectSettings(project.projectKey, {
        verification: { command: ENV_FAIL },
      });
      const run = await host.ctx.runLifecycle.start({
        idea: "Add a status endpoint",
        projectKey: project.projectKey,
        baseBranch: await currentBranch(repo),
        workflowBundleId: "ticket",
      });
      expect(run.state.status).toBe("completed");
      expect(run.state.artifacts.imageRepairAttempts).toBe(1);
      const proposal = run.state.artifacts.imageRepair as { image?: string } | undefined;
      expect(proposal?.image).toContain("agent-harness-worker-run-");
      expect(implementer.inputs).toHaveLength(1);
      expect(reviewer.inputs).toHaveLength(1);
    } finally {
      await host.dispose();
    }
  });

  it("still blocks when image repair attempts are exhausted", async () => {
    const repo = await createTempRepo();
    await commitScript(repo, "fail-env.js", `console.error("could not find java");\nprocess.exit(1);\n`);
    const implementer = recorder(() => ({ summary: "done", files: [] }));
    const reviewer = recorder(() => ({ verdict: "approve", summary: "ok" }));
    const { host } = await bootTestHost({
      bundles: [TICKET],
      agents: {
        mode: "fake",
        scripted: {
          implementer: implementer.reply,
          "task-reviewer": reviewer.reply,
          "image-fixer": imageFixerReply,
        },
      },
    });
    try {
      stubDockerSandbox(host);
      patchVerify(host, () => "real");
      const project = await host.ctx.projects.add(repo);
      await host.ctx.store.writeProjectSettings(project.projectKey, {
        verification: { command: ENV_FAIL },
      });
      const run = await host.ctx.runLifecycle.start({
        idea: "Add a status endpoint",
        projectKey: project.projectKey,
        baseBranch: await currentBranch(repo),
        workflowBundleId: "ticket",
      });
      expect(run.state.status).toBe("blocked");
      expect(run.state.block?.reason).toMatch(/environment failure/i);
      expect(run.state.artifacts.imageRepairAttempts).toBe(2);
      expect(implementer.inputs).toHaveLength(1);
      expect(reviewer.inputs).toHaveLength(0);
    } finally {
      await host.dispose();
    }
  });

  it("preflights and repairs the image at verification-settings", async () => {
    const PREFLIGHT: WorkflowBundle = {
      id: "preflight",
      phases: ["verification-settings", "implement", "publish"],
    };
    const repo = await createTempRepo();
    await commitScript(repo, "fail-env.js", `console.error("could not find java");\nprocess.exit(1);\n`);
    const { host } = await bootTestHost({
      bundles: [PREFLIGHT],
      agents: {
        mode: "fake",
        scripted: {
          "image-fixer": imageFixerReply,
          // Empty proposal so the gate falls back to the live project command.
          "project-profiler": () => ({}),
        },
      },
    });
    try {
      stubDockerSandbox(host);
      patchVerify(host, (calls) => (calls === 1 ? "real" : "pass"));
      const project = await host.ctx.projects.add(repo);
      await host.ctx.store.writeProjectSettings(project.projectKey, {
        verification: { command: ENV_FAIL },
      });
      const started = await host.ctx.runLifecycle.start({
        idea: "Add a status endpoint",
        projectKey: project.projectKey,
        baseBranch: await currentBranch(repo),
        workflowBundleId: "preflight",
      });
      expect(started.state.phase).toBe("verification-settings");
      expect(started.state.status).toBe("awaiting_input");
      const run = await host.ctx.runLifecycle.answer(started.identity.runId, {
        answers: { selection: "generic" },
      });
      expect(run.state.status).toBe("completed");
      expect(run.state.artifacts.imageRepairAttempts).toBe(1);
    } finally {
      await host.dispose();
    }
  });
});

describe("final-review repair loop", () => {
  it("spawns a fresh implementer with the findings and re-reviews", async () => {
    const repo = await createTempRepo();
    const implementer = recorder(() => ({ summary: "done", files: [] }));
    const reviewer = recorder((_input, calls) =>
      calls === 1
        ? { verdict: "reject", summary: "Endpoint lacks error handling" }
        : { verdict: "approve", summary: "ok" },
    );
    const { host } = await bootTestHost({
      bundles: [REVIEW_ONLY],
      agents: { mode: "fake", scripted: { implementer: implementer.reply, reviewer: reviewer.reply } },
    });
    try {
      const project = await host.ctx.projects.add(repo);
      const run = await host.ctx.runLifecycle.start({
        idea: "Add a status endpoint",
        projectKey: project.projectKey,
        baseBranch: await currentBranch(repo),
        workflowBundleId: "review-only",
      });
      expect(run.state.status).toBe("completed");
      expect(run.state.artifacts.finalReviewAttempts).toBe(1);
      expect(implementer.inputs).toHaveLength(2);
      expect(reviewer.inputs).toHaveLength(2);
      const repair = lastInput(implementer);
      expect(repair.repair).toBe(true);
      expect((repair.finalReview as { summary?: string } | undefined)?.summary).toBe(
        "Endpoint lacks error handling",
      );
    } finally {
      await host.dispose();
    }
  });

  it("blocks after exhausting final-review repair attempts", async () => {
    const repo = await createTempRepo();
    const implementer = recorder(() => ({ summary: "done", files: [] }));
    const reviewer = recorder(() => ({ verdict: "reject", summary: "still wrong" }));
    const { host } = await bootTestHost({
      bundles: [REVIEW_ONLY],
      agents: { mode: "fake", scripted: { implementer: implementer.reply, reviewer: reviewer.reply } },
    });
    try {
      const project = await host.ctx.projects.add(repo);
      await host.ctx.store.writeProjectSettings(project.projectKey, {
        workflow: { maxFinalReviewAttempts: 1 },
      });
      const run = await host.ctx.runLifecycle.start({
        idea: "Add a status endpoint",
        projectKey: project.projectKey,
        baseBranch: await currentBranch(repo),
        workflowBundleId: "review-only",
      });
      expect(run.state.status).toBe("blocked");
      expect(run.state.block?.reason).toMatch(/Final review requested changes after 1 repair/);
      expect(implementer.inputs).toHaveLength(2);
      expect(reviewer.inputs).toHaveLength(2);
    } finally {
      await host.dispose();
    }
  });
});

import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { formatCursorAgentFailure } from "../domain/cursor-agent-error.js";
import type { AgentInvocation, WorkPacket } from "../domain/types.js";

export type AgentsService = {
  invoke(role: string, packet: WorkPacket): Promise<unknown>;
};

export type ScriptedReply = unknown | ((role: string, packet: WorkPacket) => unknown);

export type AgentsConfig = {
  mode?: "fake" | "cursor";
  scripted?: Record<string, ScriptedReply>;
};

export function defaultFakeReply(role: string, packet: WorkPacket): unknown {
  const idea = extractIdea(packet.input);
  switch (role) {
    case "reflector":
      return {
        proposedTitle: "Clarify request",
        summary: "Restate the request without adding requirements.",
        restatement: `The request is: ${idea}`,
        goal: "Establish a shared understanding of the request before grilling.",
        users: ["operators of the registered repository"],
        inScope: ["the requested outcome"],
        outOfScope: ["unrelated refactors"],
        assumptions: ["The operator wants a thin vertical slice."],
        unknowns: ["Who are the users?", "What is explicitly out of scope?"],
      };
    case "griller": {
      const input = packet.input as {
        fog?: Array<{ status: string }>;
        resolutions?: unknown[];
      } | undefined;
      const fog = input?.fog ?? [];
      if ((input?.resolutions?.length ?? 0) > 0) {
        return { questions: [], unknowns: [] };
      }
      if (fog.length > 0 && fog.every((entry) => entry.status === "resolved" || entry.status === "parked")) {
        return { questions: [], unknowns: [] };
      }
      if (fog.some((entry) => entry.status === "resolved")) {
        return { questions: [], unknowns: [] };
      }
      return {
        questions: [
          {
            id: "users",
            prompt: "Who are the primary users?",
            kind: "text",
            recommended: "operators of the registered repository",
          },
          {
            id: "scope",
            prompt: "What is out of scope for this slice?",
            kind: "text",
            recommended: "unrelated refactors",
          },
        ],
        unknowns: ["Who are the users?", "What is explicitly out of scope?"],
      };
    }
    case "docs-writer":
      return packet.phase === "prd"
        ? { title: idea.slice(0, 72) || "Feature", body: `# PRD\n\n${idea}\n` }
        : { glossary: [{ term: "Run", definition: "A durable idea-to-feature execution." }] };
    case "project-profiler":
      return { command: "npm test", testGlobs: ["**/*.test.ts"] };
    case "planner":
      return { plan: `1. Restate the goal.\n2. Implement the smallest change.\n3. Verify.\n\nGoal: ${idea}` };
    case "scenario-planner":
      return {
        scenarios: [{ id: "happy-path", title: "Happy path", steps: ["Start from the idea", "Reach a passing check"] }],
      };
    case "issue-slicer":
      return {
        tasks: [{ id: "task-1", title: "Implement the slice", description: idea }],
      };
    case "implementer":
      return { summary: `Implemented ${idea}`, files: ["README.md"], note: "fake-agent" };
    case "task-reviewer":
    case "reviewer":
      return { verdict: "approve", summary: "Looks consistent with the packet." };
    case "scenario-writer":
    case "fixer":
      return { summary: "No repair required.", passed: true };
    case "message-writer":
      return { title: idea.slice(0, 72) || "Feature", body: idea };
    default:
      return { summary: `fake:${role}`, idea };
  }
}

export function createFakeAgents(scripted: Record<string, ScriptedReply> = {}): AgentsService {
  return {
    async invoke(role, packet) {
      const reply = scripted[role];
      if (typeof reply === "function") return reply(role, packet);
      if (reply !== undefined) return reply;
      return defaultFakeReply(role, packet);
    },
  };
}

export function createCursorAgents(ctx: Context): AgentsService {
  return {
    async invoke(role, packet) {
      const run = await ctx.store.readIdentity(packet.runId);
      if (!run) throw new Error(`Cannot invoke agent for unknown run ${packet.runId}`);
      const result = await ctx.sandbox.exec(run.runId, {
        command: ["node", "/opt/agent-harness/dist/worker/invoke.js"],
        stdin: JSON.stringify({ role, packet }),
      });
      if (result.exitCode !== 0) {
        throw new Error(formatCursorAgentFailure(role, result));
      }
      return JSON.parse(result.stdout) as unknown;
    },
  };
}

export function agentsPlugin(ctx: Context, config: AgentsConfig = {}): void {
  const mode = config.mode ?? (process.env.AGENT_HARNESS_AGENTS === "cursor" ? "cursor" : "fake");
  const service = mode === "cursor" ? createCursorAgents(ctx) : createFakeAgents(config.scripted ?? {});
  ctx.provide("agents", wrapWithSessions(ctx, service));
}

Object.assign(agentsPlugin, { inject: ["store", "sandbox"] });

function wrapWithSessions(ctx: Context, inner: AgentsService): AgentsService {
  return {
    async invoke(role, packet) {
      const output = await inner.invoke(role, packet);
      const invocation: AgentInvocation = {
        role,
        packet,
        output,
        at: new Date().toISOString(),
      };
      await ctx.store.writeSession(packet.runId, randomUUID(), invocation);
      return output;
    },
  };
}

function extractIdea(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "idea" in input) {
    const idea = (input as { idea?: unknown }).idea;
    if (typeof idea === "string") return idea;
  }
  return JSON.stringify(input ?? "");
}

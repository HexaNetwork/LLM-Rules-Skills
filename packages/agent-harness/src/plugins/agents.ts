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
        restatement: idea,
        goal: "Establish a shared understanding of the request before grilling.",
        users: ["end users of the product"],
        inScope: ["the requested outcome"],
        outOfScope: ["unrelated refactors"],
        assumptions: ["A thin vertical slice is preferred."],
        unknowns: ["Who are the users?", "What is explicitly out of scope?"],
      };
    case "griller": {
      const input = packet.input as {
        fog?: Array<{ id: string; status: string }>;
        resolutions?: unknown[];
      } | undefined;
      const fog = input?.fog ?? [];
      const open = fog.filter((entry) => entry.status === "fog" || entry.status === "asked");
      if (open.length === 0) return { questions: [], newUnknowns: [], resolvedUnknowns: [] };
      return {
        questions: [
          {
            id: "users",
            fogIds: [open[0]?.id].filter(Boolean),
            prompt: "Who are the primary users?",
            context: "This shapes who the slice must serve and how we phrase the brief.",
            options: [
              {
                id: "end-users",
                label: "End users of the product",
                description: "People who use the shipped feature.",
              },
              {
                id: "maintainers",
                label: "Maintainers of this repository",
                description: "People who develop or operate the codebase itself.",
              },
            ],
            recommendedOptionId: "end-users",
            recommendation: "Default to product end users unless the idea clearly targets maintainers.",
          },
          {
            id: "scope",
            fogIds: [open[1]?.id].filter(Boolean),
            prompt: "What is out of scope for this slice?",
            context: "Keep the first cut thin enough to verify and publish.",
            options: [
              {
                id: "refactors",
                label: "Unrelated refactors",
                description: "Skip drive-by cleanups that are not required for the slice.",
              },
              {
                id: "adjacent",
                label: "Adjacent features",
                description: "Defer nearby work that can ship in a follow-up run.",
              },
            ],
            recommendedOptionId: "refactors",
            recommendation: "Park unrelated refactors so the slice stays reviewable.",
          },
        ].filter((question) => question.fogIds.length > 0),
        newUnknowns: [],
        resolvedUnknowns: [],
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
        scenarios: [
          {
            id: "happy-path",
            title: "Happy path",
            steps: ["A user starts from the idea", "The verification command exits zero"],
          },
        ],
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
      const sessionId = randomUUID();
      const startedAt = new Date().toISOString();
      try {
        const output = await inner.invoke(role, packet);
        const endedAt = new Date().toISOString();
        const invocation: AgentInvocation = {
          sessionId,
          role,
          packet,
          output,
          startedAt,
          endedAt,
          at: endedAt,
          status: "completed",
        };
        await persistSession(ctx, packet, invocation);
        return output;
      } catch (error) {
        const endedAt = new Date().toISOString();
        const message = error instanceof Error ? error.message : String(error);
        const invocation: AgentInvocation = {
          sessionId,
          role,
          packet,
          startedAt,
          endedAt,
          at: endedAt,
          status: "failed",
          error: message,
        };
        await persistSession(ctx, packet, invocation);
        throw error;
      }
    },
  };
}

async function persistSession(
  ctx: Context,
  packet: WorkPacket,
  invocation: AgentInvocation,
): Promise<void> {
  await ctx.store.writeSession(packet.runId, invocation.sessionId, invocation);
  await ctx.store.appendEvent(packet.runId, {
    kind: "agent",
    at: invocation.endedAt,
    sessionId: invocation.sessionId,
    role: invocation.role,
    phase: packet.phase,
    status: invocation.status,
  });
}

function extractIdea(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "idea" in input) {
    const idea = (input as { idea?: unknown }).idea;
    if (typeof idea === "string") return idea;
  }
  return JSON.stringify(input ?? "");
}

import type { Context } from "@deepseek-ai/cordis";
import { CHARS_PER_TOKEN } from "../domain/token-estimate.js";
import type { ProjectSettings } from "../domain/settings.js";
import { maxAgentTokensFor } from "../domain/settings.js";
import type { WorkPacket } from "../domain/types.js";

export type PacketInput = {
  role: string;
  runId: string;
  phase: string;
  input: unknown;
  guidance?: string;
  retrieval?: string;
  settings: ProjectSettings;
  resumeAgentId?: string;
};

export type PacketService = {
  build(input: PacketInput): WorkPacket;
};

export function createPacketService(): PacketService {
  return {
    build(input) {
      const truncated: string[] = [];
      const guidance = input.guidance ?? "";
      const retrieval = clipRetrieval(
        input.retrieval ?? "",
        input.settings.budgets.graphifyTokens,
        truncated,
      );
      const packet: WorkPacket = {
        role: input.role,
        runId: input.runId,
        phase: input.phase,
        model:
          input.role === "message-writer" || input.role === "docs-writer"
            ? input.settings.models.small
            : input.settings.models.default,
        input: input.input ?? {},
        guidance,
        retrieval,
        maxAgentTokens: maxAgentTokensFor(input.role, input.settings),
        agentTimeoutMs: input.settings.workflow.agentTimeoutMinutes * 60_000,
        budget: {
          graphifyTokens: input.settings.budgets.graphifyTokens,
          truncated,
        },
      };
      if (input.resumeAgentId) packet.resumeAgentId = input.resumeAgentId;
      return packet;
    },
  };
}

function clipRetrieval(text: string, tokens: number, truncated: string[]): string {
  const max = tokens * CHARS_PER_TOKEN;
  if (text.length <= max) return text;
  truncated.push("retrieval");
  return text.slice(0, Math.max(0, max));
}

export const packetsPlugin = Object.assign(
  (ctx: Context) => {
    ctx.provide("packets", createPacketService());
  },
  {},
);

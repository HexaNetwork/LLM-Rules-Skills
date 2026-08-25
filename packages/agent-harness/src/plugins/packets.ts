import type { Context } from "@deepseek-ai/cordis";
import type { ProjectSettings } from "../domain/settings.js";
import type { WorkPacket } from "../domain/types.js";

export type PacketInput = {
  role: string;
  runId: string;
  phase: string;
  input: unknown;
  guidance?: string;
  retrieval?: string;
  settings: ProjectSettings;
};

export type PacketService = {
  build(input: PacketInput): WorkPacket;
};

const CHARS_PER_TOKEN = 4;

export function createPacketService(): PacketService {
  return {
    build(input) {
      const truncated: string[] = [];
      const guidance = clip(input.guidance ?? "", input.settings.budgets.guidanceTokens, "guidance", truncated);
      const retrieval = clip(input.retrieval ?? "", input.settings.budgets.graphifyTokens, "retrieval", truncated);
      const serialized = JSON.stringify(input.input ?? {});
      const clippedInput = clip(serialized, input.settings.budgets.inputTokens, "input", truncated);
      return {
        role: input.role,
        runId: input.runId,
        phase: input.phase,
        model: input.role === "message-writer" ? input.settings.models.small : input.settings.models.default,
        input: clippedInput === serialized ? input.input : clippedInput,
        guidance,
        retrieval,
        budget: {
          guidanceTokens: input.settings.budgets.guidanceTokens,
          inputTokens: input.settings.budgets.inputTokens,
          graphifyTokens: input.settings.budgets.graphifyTokens,
          truncated,
        },
      };
    },
  };
}

function clip(text: string, tokens: number, label: string, truncated: string[]): string {
  const max = tokens * CHARS_PER_TOKEN;
  if (text.length <= max) return text;
  truncated.push(label);
  return text.slice(0, Math.max(0, max));
}

export const packetsPlugin = Object.assign(
  (ctx: Context) => {
    ctx.provide("packets", createPacketService());
  },
  {},
);

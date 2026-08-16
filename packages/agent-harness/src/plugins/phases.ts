import type { Context } from "@deepseek-ai/cordis";
import type { Phase } from "../domain/types.js";

export type PhaseRegistry = {
  register(phase: Phase): void;
  get(id: string): Phase;
  list(): Phase[];
};

export function createPhaseRegistry(phases: Phase[] = []): PhaseRegistry {
  const byId = new Map<string, Phase>();
  const register = (phase: Phase) => {
    if (byId.has(phase.id)) throw new Error(`Duplicate phase registration: ${phase.id}`);
    byId.set(phase.id, phase);
  };
  for (const phase of phases) register(phase);
  return {
    register,
    get(id) {
      const phase = byId.get(id);
      if (!phase) throw new Error(`Unknown phase: ${id}`);
      return phase;
    },
    list: () => [...byId.values()],
  };
}

export function phasesPlugin(ctx: Context, config: { phases?: Phase[] } = {}): void {
  ctx.provide("phases", createPhaseRegistry(config.phases ?? []));
}


export function definePhasePlugin(phase: Phase) {
  const plugin = (ctx: Context) => ctx.phases.register(phase);
  return Object.assign(plugin, {
    inject: ["phases", "knowledge", "packets", "agents", "git", "commands", "store", "settings"],
  });
}

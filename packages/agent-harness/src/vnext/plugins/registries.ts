import type { Context } from "@deepseek-ai/cordis";
import type {
  RoleDescriptor,
  RoleRegistryService,
  WorkflowPhaseHandler,
  WorkflowRegistryService,
} from "../services/contracts.js";

export function roleRegistryPlugin(ctx: Context): void {
  const roles = new Map<string, RoleDescriptor>();
  const service: RoleRegistryService = {
    register(descriptor) {
      if (roles.has(descriptor.id)) {
        throw new Error(`Duplicate role registration: ${descriptor.id}`);
      }
      const stored = Object.freeze({ ...descriptor });
      roles.set(descriptor.id, stored);
      return () => {
        if (roles.get(descriptor.id) === stored) roles.delete(descriptor.id);
      };
    },
    get: (id) => roles.get(id),
    list: () => [...roles.values()],
  };
  ctx.provide("roles", service);
}

export function workflowRegistryPlugin(ctx: Context): void {
  const handlers = new Map<string, WorkflowPhaseHandler>();
  const service: WorkflowRegistryService = {
    register(handler) {
      if (handlers.has(handler.phase)) {
        throw new Error(`Multiple workflow handlers registered for phase "${handler.phase}"`);
      }
      handlers.set(handler.phase, handler);
      return () => {
        if (handlers.get(handler.phase) === handler) handlers.delete(handler.phase);
      };
    },
    get: (phase) => handlers.get(phase),
    list: () => [...handlers.values()],
    validate(nonterminalPhases) {
      const missing = nonterminalPhases.filter((phase) => !handlers.has(phase));
      if (missing.length > 0) {
        throw new Error(`Workflow phases without exactly one handler: ${missing.join(", ")}`);
      }
    },
  };
  ctx.provide("workflow", service);
}

export function defineRolePlugin(descriptor: RoleDescriptor) {
  const plugin = (ctx: Context) => ctx.roles.register(descriptor);
  return Object.assign(plugin, { inject: ["roles"] });
}

export function definePhasePlugin(handler: WorkflowPhaseHandler) {
  const plugin = (ctx: Context) => ctx.workflow.register(handler);
  return Object.assign(plugin, { inject: ["workflow"] });
}

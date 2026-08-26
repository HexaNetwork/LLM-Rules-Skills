import type { Context } from "@deepseek-ai/cordis";
import {
  mergeSettings,
  type ProjectSettings,
  type SettingsAuditEntry,
} from "../domain/settings.js";
import type { StoreService } from "./store.js";

export type SettingsService = {
  defaults(): ProjectSettings;
  readLive(projectKey?: string): Promise<ProjectSettings>;
  readAgentTimeout(projectKey?: string): Promise<AgentTimeoutConfig>;
  writeAgentTimeout(timeoutMinutes: number | null, projectKey?: string): Promise<AgentTimeoutConfig>;
  audit(runId: string, source: SettingsAuditEntry["source"], settings: ProjectSettings): Promise<void>;
};

export type AgentTimeoutConfig = {
  defaultMinutes: number;
  globalMinutes?: number;
  projectMinutes?: number;
  effectiveMinutes: number;
  projectKey?: string;
};

export function createSettingsService(store: StoreService): SettingsService {
  return {
    defaults: () => mergeSettings(),
    async readLive(projectKey) {
      const global = await store.readGlobalSettings();
      const project = projectKey ? await store.readProjectSettings(projectKey) : {};
      return mergeSettings(global, project);
    },
    async readAgentTimeout(projectKey) {
      return readAgentTimeoutConfig(store, projectKey);
    },
    async writeAgentTimeout(timeoutMinutes, projectKey) {
      if (timeoutMinutes !== null) {
        mergeSettings({
          workflow: { agentTimeoutMinutes: timeoutMinutes },
        } as Partial<ProjectSettings>);
      }
      const relativePath = projectKey
        ? `projects/${projectKey}/settings.json`
        : "settings.json";
      const raw = (await store.readJson<Record<string, unknown>>(relativePath)) ?? {};
      const workflow = asRecord(raw.workflow);
      if (timeoutMinutes === null) delete workflow.agentTimeoutMinutes;
      else workflow.agentTimeoutMinutes = timeoutMinutes;
      if (Object.keys(workflow).length === 0) delete raw.workflow;
      else raw.workflow = workflow;
      if (projectKey) {
        await store.writeProjectSettings(projectKey, raw as Partial<ProjectSettings>);
      } else {
        await store.writeGlobalSettings(raw as Partial<ProjectSettings>);
      }
      return readAgentTimeoutConfig(store, projectKey);
    },
    async audit(runId, source, settings) {
      await store.appendSettingsAudit(runId, {
        at: new Date().toISOString(),
        source,
        settings,
      });
    },
  };
}

async function readAgentTimeoutConfig(
  store: StoreService,
  projectKey?: string,
): Promise<AgentTimeoutConfig> {
  const defaults = mergeSettings();
  const globalRaw = (await store.readJson<Record<string, unknown>>("settings.json")) ?? {};
  const projectRaw = projectKey
    ? (await store.readJson<Record<string, unknown>>(`projects/${projectKey}/settings.json`)) ?? {}
    : {};
  const globalMinutes = timeoutOverride(globalRaw);
  const projectMinutes = timeoutOverride(projectRaw);
  const effective = await createSettingsService(store).readLive(projectKey);
  return {
    defaultMinutes: defaults.workflow.agentTimeoutMinutes,
    ...(globalMinutes !== undefined ? { globalMinutes } : {}),
    ...(projectMinutes !== undefined ? { projectMinutes } : {}),
    effectiveMinutes: effective.workflow.agentTimeoutMinutes,
    ...(projectKey ? { projectKey } : {}),
  };
}

function timeoutOverride(raw: Record<string, unknown>): number | undefined {
  const value = asRecord(raw.workflow).agentTimeoutMinutes;
  return typeof value === "number" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export const settingsPlugin = Object.assign(
  (ctx: Context) => {
    ctx.provide("settings", createSettingsService(ctx.store));
  },
  { inject: ["store"] },
);

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
  audit(runId: string, source: SettingsAuditEntry["source"], settings: ProjectSettings): Promise<void>;
};

export function createSettingsService(store: StoreService): SettingsService {
  return {
    defaults: () => mergeSettings(),
    async readLive(projectKey) {
      const global = await store.readGlobalSettings();
      const project = projectKey ? await store.readProjectSettings(projectKey) : {};
      return mergeSettings(global, project);
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

export const settingsPlugin = Object.assign(
  (ctx: Context) => {
    ctx.provide("settings", createSettingsService(ctx.store));
  },
  { inject: ["store"] },
);

import { mergeSettings, type ProjectSettings } from "./domain/settings.js";
import {
  createHostProfile,
  validateProfileDefinition,
  type BootOptions,
  type ProfileDefinition,
} from "./boot.js";
import { defaultHarnessHome } from "./home.js";

export function dumpProfileConfig(
  profile: ProfileDefinition,
  extras: { home: string; settings: ProjectSettings; workflowBundles: string[] },
): string {
  validateProfileDefinition(profile);
  return JSON.stringify(
    {
      profile: profile.name,
      production: profile.production,
      hmr: profile.hmr,
      home: extras.home,
      requiredServices: profile.requiredServices,
      workflowBundles: extras.workflowBundles,
      settings: redact(extras.settings),
      rows: profile.rows.map((row) => ({
        id: row.id,
        plugin: pluginName(row.plugin),
        disabled: row.disabled === true,
        trusted: row.trusted === true,
        provides: row.provides ?? [],
        config: redact(row.config),
      })),
    },
    null,
    2,
  );
}

export async function dumpHostConfig(options: BootOptions = {}): Promise<string> {
  const home = options.home ?? defaultHarnessHome();
  const extraRows =
    options.extraRows ?? (await import("./plugins/profile.js")).hostRuntimeRows();
  const profile = createHostProfile({ ...options, home, extraRows });
  const { createFileStore } = await import("./plugins/store.js");
  const { createSettingsService } = await import("./plugins/settings.js");
  const store = createFileStore(home);
  const settings = createSettingsService(store);
  const live = await settings.readLive();
  return dumpProfileConfig(profile, {
    home,
    settings: live,
    workflowBundles: ["default", "ticket"],
  });
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = /^(?:.*[._-])?(?:token|secret|credential|api.?key|password)$/i.test(key)
      ? "[REDACTED]"
      : redact(item);
  }
  return result;
}

function pluginName(plugin: { name?: string }): string {
  return plugin.name && plugin.name.length > 0 ? plugin.name : "(anonymous-plugin)";
}

export { mergeSettings };

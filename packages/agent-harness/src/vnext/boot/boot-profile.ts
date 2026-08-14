import { Context, type Fiber, type Plugin } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Include from "@deepseek-ai/cordis-plugin-include";
import Group from "@deepseek-ai/cordis-plugin-group";
import type { VNextServiceName } from "../services/contracts.js";

export type ProfileRow = {
  id: string;
  plugin: Plugin<any>;
  config?: unknown;
  provides?: VNextServiceName[];
  disabled?: boolean;
  trusted?: true;
};

export type ProfileDefinition = {
  name: "host" | "worker" | "deterministic-test" | string;
  production: boolean;
  hmr: false;
  requiredServices: VNextServiceName[];
  rows: ProfileRow[];
};

export type ProfileDiagnostic = {
  id: string;
  status: "active" | "disabled" | "pending" | "failed";
  provides: VNextServiceName[];
  error?: string;
};

export type BootedProfile = {
  ctx: Context;
  diagnostics: ProfileDiagnostic[];
  dispose(): Promise<void>;
};

export function validateProfileDefinition(profile: ProfileDefinition): void {
  if (profile.hmr !== false) throw new Error(`Profile "${profile.name}" must disable HMR`);
  const ids = new Set<string>();
  const providers = new Map<VNextServiceName, string[]>();
  for (const row of profile.rows) {
    if (!row.id.trim()) throw new Error(`Profile "${profile.name}" contains an empty row id`);
    if (ids.has(row.id)) throw new Error(`Duplicate profile row id: ${row.id}`);
    ids.add(row.id);
    if (profile.production && row.trusted !== true) {
      throw new Error(`Production profile row "${row.id}" is not declared trusted host software`);
    }
    if (row.disabled) continue;
    for (const service of row.provides ?? []) {
      providers.set(service, [...(providers.get(service) ?? []), row.id]);
    }
  }
  for (const service of profile.requiredServices) {
    const rows = providers.get(service) ?? [];
    if (rows.length === 0) {
      throw new Error(`Required service "${service}" has no enabled provider in ${profile.name}`);
    }
    if (rows.length > 1) {
      throw new Error(`Required service "${service}" has duplicate providers: ${rows.join(", ")}`);
    }
  }
  if (profile.production) {
    const securityRows = providers.get("securityPolicy") ?? [];
    if (securityRows.length !== 1) {
      throw new Error(
        `Production profile requires exactly one security-policy plugin; found ${securityRows.length}`,
      );
    }
  }
}

export async function bootProfile(profile: ProfileDefinition): Promise<BootedProfile> {
  validateProfileDefinition(profile);
  const root = new Context();
  const fibers: Array<{ row: ProfileRow; fiber: Fiber }> = [];
  const diagnostics: ProfileDiagnostic[] = [];
  try {
    const loaderFiber = await root.plugin(Loader, { baseUrl: import.meta.url });
    await loaderFiber.await();
    // Include and Group are trusted builtins. Profiles are host-authored data;
    // target repositories never supply module specifiers or patches.
    root.loader.builtins["cordis:include"] = Include;
    root.loader.builtins["cordis:group"] = Group;

    for (const row of profile.rows) {
      if (row.disabled) {
        diagnostics.push({ id: row.id, status: "disabled", provides: row.provides ?? [] });
        continue;
      }
      const fiber = await root.plugin(row.plugin, row.config as never);
      fibers.push({ row, fiber });
    }
    for (const entry of fibers) {
      try {
        await entry.fiber.await();
        diagnostics.push({
          id: entry.row.id,
          status: "active",
          provides: entry.row.provides ?? [],
        });
      } catch (error) {
        diagnostics.push({
          id: entry.row.id,
          status: "failed",
          provides: entry.row.provides ?? [],
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    for (const service of profile.requiredServices) {
      if (root.get(service) === undefined) {
        const provider = profile.rows.find((row) => row.provides?.includes(service));
        diagnostics.push({
          id: provider?.id ?? `service:${service}`,
          status: "pending",
          provides: [service],
          error: `Service "${service}" was declared but not activated`,
        });
        throw new Error(
          `Profile "${profile.name}" activation left required service "${service}" pending`,
        );
      }
    }
    return {
      ctx: root,
      diagnostics,
      dispose: () => root.fiber.dispose(),
    };
  } catch (error) {
    await root.fiber.dispose().catch(() => undefined);
    const details = diagnostics
      .filter((item) => item.status !== "active")
      .map((item) => `${item.id}:${item.status}${item.error ? ` (${item.error})` : ""}`)
      .join(", ");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to boot Cordis profile "${profile.name}": ${message}${details ? `; ${details}` : ""}`, {
      cause: error,
    });
  }
}

export function dumpProfileConfig(profile: ProfileDefinition): string {
  validateProfileDefinition(profile);
  return JSON.stringify(
    {
      profile: profile.name,
      production: profile.production,
      hmr: profile.hmr,
      requiredServices: profile.requiredServices,
      rows: profile.rows.map((row) => ({
        id: row.id,
        plugin: row.plugin.name || "(anonymous-plugin)",
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

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = /(token|secret|credential|api.?key|password)/i.test(key) ? "[REDACTED]" : redact(item);
  }
  return result;
}

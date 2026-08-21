import { Context, type Fiber, type Plugin } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Include from "@deepseek-ai/cordis-plugin-include";
import Group from "@deepseek-ai/cordis-plugin-group";
import "./context.js";
import { defaultHarnessHome } from "./home.js";
import { storePlugin } from "./plugins/store.js";
import { settingsPlugin } from "./plugins/settings.js";

export const HOST_SERVICE_NAMES = [
  "store",
  "settings",
  "projects",
  "workflow",
  "phases",
  "packets",
  "agents",
  "git",
  "sandbox",
  "knowledge",
  "roleGuidance",
  "commands",
  "runLifecycle",
] as const;

export type HostServiceName = (typeof HOST_SERVICE_NAMES)[number];

export type ProfileRow = {
  id: string;
  plugin: Plugin;
  config?: unknown;
  provides?: HostServiceName[];
  disabled?: boolean;
  trusted?: true;
};

export type ProfileDefinition = {
  name: string;
  production: boolean;
  hmr: false;
  requiredServices: HostServiceName[];
  rows: ProfileRow[];
};

export type ProfileDiagnostic = {
  id: string;
  status: "active" | "disabled" | "pending" | "failed";
  provides: HostServiceName[];
  error?: string;
};

export type BootedHost = {
  ctx: Context;
  diagnostics: ProfileDiagnostic[];
  dispose(): Promise<void>;
};

export type BootOptions = {
  home?: string;
  extraRows?: ProfileRow[];
};

export function createHostProfile(options: BootOptions = {}): ProfileDefinition {
  const home = options.home ?? defaultHarnessHome();
  const rows: ProfileRow[] = [
    {
      id: "host.store",
      plugin: storePlugin,
      config: { home },
      provides: ["store"],
      trusted: true,
    },
    {
      id: "host.settings",
      plugin: settingsPlugin,
      provides: ["settings"],
      trusted: true,
    },
    ...(options.extraRows ?? []),
  ];
  return {
    name: "host",
    production: true,
    hmr: false,
    requiredServices: requiredFrom(rows),
    rows,
  };
}

function requiredFrom(rows: ProfileRow[]): HostServiceName[] {
  const names: HostServiceName[] = [];
  for (const row of rows) {
    if (row.disabled) continue;
    for (const name of row.provides ?? []) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

export function validateProfileDefinition(profile: ProfileDefinition): void {
  if (profile.hmr !== false) throw new Error(`Profile "${profile.name}" must disable HMR`);
  const ids = new Set<string>();
  const providers = new Map<HostServiceName, string[]>();
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
}

export async function bootProfile(profile: ProfileDefinition): Promise<BootedHost> {
  validateProfileDefinition(profile);
  const root = new Context();
  const fibers: Array<{ row: ProfileRow; fiber: Fiber }> = [];
  const diagnostics: ProfileDiagnostic[] = [];
  try {
    const loaderFiber = await root.plugin(Loader, { baseUrl: import.meta.url });
    await loaderFiber.await();
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
    throw new Error(
      `Failed to boot Cordis profile "${profile.name}": ${message}${details ? `; ${details}` : ""}`,
      { cause: error },
    );
  }
}

export async function bootHost(options: BootOptions = {}): Promise<BootedHost> {
  const extraRows =
    options.extraRows ?? (await import("./plugins/profile.js")).hostRuntimeRows();
  return bootProfile(createHostProfile({ ...options, extraRows }));
}

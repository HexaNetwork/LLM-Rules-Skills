import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import { AGENT_ROLES, renderRoleContext } from "../domain/agent-roles.js";

export type RoleGuidanceSource = "packaged" | "home" | "project";

export type RoleGuidanceEntry = {
  role: string;
  source: RoleGuidanceSource;
  hasHomeOverride: boolean;
  hasProjectOverride: boolean;
};

export type RoleGuidanceDocument = RoleGuidanceEntry & {
  body: string;
  packagedBody: string;
  path: string;
};

export type CompiledRoleContext = {
  role: string;
  source: RoleGuidanceSource;
  text: string;
};

export type CompileRoleContextOptions = {
  projectKey?: string;
};

export type RoleGuidanceService = {
  listRoles(projectKey?: string): Promise<RoleGuidanceEntry[]>;
  read(role: string, projectKey?: string): Promise<RoleGuidanceDocument>;
  writeOverride(role: string, body: string, projectKey?: string): Promise<RoleGuidanceDocument>;
  resetOverride(role: string, projectKey?: string): Promise<RoleGuidanceDocument>;
  compileRoleContext(role: string, options: CompileRoleContextOptions): Promise<CompiledRoleContext>;
};

function assertKnownRole(role: string): void {
  if (!(AGENT_ROLES as readonly string[]).includes(role)) {
    throw new Error(`Unknown role: ${role}`);
  }
}

function assertSafeProjectKey(projectKey: string): void {
  if (!projectKey || projectKey !== path.basename(projectKey) || projectKey.includes("\0")) {
    throw new Error(`Invalid project key: ${projectKey}`);
  }
}

function packagedRolesRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../templates/guidance/roles");
}

function homeRolePath(home: string, role: string): string {
  return path.join(home, "guidance", "roles", role, "GUIDANCE.md");
}

function projectRolePath(home: string, projectKey: string, role: string): string {
  return path.join(home, "projects", projectKey, "guidance", "roles", role, "GUIDANCE.md");
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function createRoleGuidanceService(home: string): RoleGuidanceService {
  const resolve = async (
    role: string,
    projectKey?: string,
  ): Promise<{ source: RoleGuidanceSource; path: string; body: string }> => {
    if (projectKey) {
      const projectPath = projectRolePath(home, projectKey, role);
      const body = await readText(projectPath);
      if (body !== undefined) return { source: "project", path: projectPath, body };
    }
    const homePath = homeRolePath(home, role);
    const homeBody = await readText(homePath);
    if (homeBody !== undefined) return { source: "home", path: homePath, body: homeBody };
    const packagedPath = path.join(packagedRolesRoot(), role, "GUIDANCE.md");
    const packagedBody = await readText(packagedPath);
    if (packagedBody === undefined) {
      throw new Error(`No packaged guidance found for role: ${role}`);
    }
    return { source: "packaged", path: packagedPath, body: packagedBody };
  };

  const read = async (role: string, projectKey?: string): Promise<RoleGuidanceDocument> => {
    assertKnownRole(role);
    if (projectKey) assertSafeProjectKey(projectKey);
    const resolved = await resolve(role, projectKey);
    const packagedBody = (await readText(path.join(packagedRolesRoot(), role, "GUIDANCE.md"))) ?? "";
    const hasHomeOverride = (await readText(homeRolePath(home, role))) !== undefined;
    const hasProjectOverride = projectKey
      ? (await readText(projectRolePath(home, projectKey, role))) !== undefined
      : false;
    return {
      role,
      source: resolved.source,
      path: resolved.path,
      body: resolved.body,
      packagedBody,
      hasHomeOverride,
      hasProjectOverride,
    };
  };

  return {
    async listRoles(projectKey) {
      if (projectKey) assertSafeProjectKey(projectKey);
      const roles: RoleGuidanceEntry[] = [];
      for (const role of AGENT_ROLES) {
        const resolved = await resolve(role, projectKey);
        roles.push({
          role,
          source: resolved.source,
          hasHomeOverride: (await readText(homeRolePath(home, role))) !== undefined,
          hasProjectOverride: projectKey
            ? (await readText(projectRolePath(home, projectKey, role))) !== undefined
            : false,
        });
      }
      return roles;
    },

    read,

    async writeOverride(role, body, projectKey) {
      assertKnownRole(role);
      if (typeof body !== "string" || !body.trim()) {
        throw new Error("Guidance body is required");
      }
      const target = projectKey
        ? (assertSafeProjectKey(projectKey), projectRolePath(home, projectKey, role))
        : homeRolePath(home, role);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body.endsWith("\n") ? body : `${body}\n`, "utf8");
      return read(role, projectKey);
    },

    async resetOverride(role, projectKey) {
      assertKnownRole(role);
      const target = projectKey
        ? (assertSafeProjectKey(projectKey), projectRolePath(home, projectKey, role))
        : homeRolePath(home, role);
      await rm(target, { force: true });
      return read(role, projectKey);
    },

    async compileRoleContext(role, options) {
      const document = await resolve(role, options.projectKey);
      const text = renderRoleContext(role, document.body);
      return { role, source: document.source, text };
    },
  };
}

export const roleGuidancePlugin = Object.assign(
  (ctx: Context) => {
    ctx.provide("roleGuidance", createRoleGuidanceService(ctx.store.home));
  },
  { inject: ["store"] },
);

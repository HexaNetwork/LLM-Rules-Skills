import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderRoleContext, WORKFLOW_ROLES } from "./roles.js";

export type GuidanceSource = "packaged" | "home" | "project";

export type GuidanceRoleSummary = { role: string; source: GuidanceSource; hasOverride: boolean };

export type GuidanceDocument = {
  role: string;
  body: string;
  source: GuidanceSource;
  packagedPath: string;
  overridePath?: string;
  roleRules: readonly string[];
  promptPreview: string;
};

export class GuidanceService {
  private readonly templatesRoot: string;

  constructor(private readonly home: string, packageRoot?: string) {
    this.templatesRoot = path.join(packageRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "templates", "guidance", "roles");
  }

  async listRoles(projectId?: string): Promise<GuidanceRoleSummary[]> {
    const packaged = await this.packagedRoles();
    const roles = new Set([...WORKFLOW_ROLES, ...packaged]);
    const summaries: GuidanceRoleSummary[] = [];
    for (const role of [...roles].sort()) {
      summaries.push({ role, source: await this.effectiveSource(role, projectId), hasOverride: await this.hasOverride(role, projectId) });
    }
    return summaries;
  }

  async read(role: string, projectId?: string): Promise<GuidanceDocument> {
    const packagedPath = path.join(this.templatesRoot, role, "GUIDANCE.md");
    const packagedBody = await readFile(packagedPath, "utf8").catch(() => "");
    const homeOverridePath = this.overridePath(role);
    const projectOverridePath = projectId ? this.overridePath(role, projectId) : undefined;
    const homeOverrideBody = await readFile(homeOverridePath, "utf8").catch(() => undefined);
    const projectOverrideBody = projectOverridePath ? await readFile(projectOverridePath, "utf8").catch(() => undefined) : undefined;
    let body = packagedBody;
    let source: GuidanceSource = "packaged";
    let overridePath: string | undefined;
    if (homeOverrideBody !== undefined) {
      body = homeOverrideBody;
      source = "home";
      overridePath = homeOverridePath;
    }
    if (projectOverrideBody !== undefined) {
      body = projectOverrideBody;
      source = "project";
      overridePath = projectOverridePath;
    }
    return {
      role,
      body,
      source,
      packagedPath,
      overridePath,
      roleRules: (await import("./roles.js")).roleRulesFor(role),
      promptPreview: renderRoleContext(role, body),
    };
  }

  async writeOverride(role: string, body: string, projectId?: string): Promise<GuidanceDocument> {
    const target = projectId ? this.overridePath(role, projectId) : this.overridePath(role);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, "utf8");
    return this.read(role, projectId);
  }

  async resetOverride(role: string, projectId?: string): Promise<GuidanceDocument> {
    const target = projectId ? this.overridePath(role, projectId) : this.overridePath(role);
    await rm(target, { force: true });
    return this.read(role, projectId);
  }

  async compileContext(role: string, projectId?: string): Promise<string> {
    const document = await this.read(role, projectId);
    return renderRoleContext(role, document.body);
  }

  private async packagedRoles(): Promise<string[]> {
    try {
      const entries = await readdir(this.templatesRoot, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch {
      return [];
    }
  }

  private overridePath(role: string, projectId?: string): string {
    if (projectId) return path.join(this.home, "projects", projectId, "guidance", `${role}.md`);
    return path.join(this.home, "guidance", `${role}.md`);
  }

  private async hasOverride(role: string, projectId?: string): Promise<boolean> {
    const projectPath = projectId ? this.overridePath(role, projectId) : undefined;
    const homePath = this.overridePath(role);
    if (projectPath && await fileExists(projectPath)) return true;
    return fileExists(homePath);
  }

  private async effectiveSource(role: string, projectId?: string): Promise<GuidanceSource> {
    if (projectId && await fileExists(this.overridePath(role, projectId))) return "project";
    if (await fileExists(this.overridePath(role))) return "home";
    return "packaged";
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await readFile(target);
    return true;
  } catch {
    return false;
  }
}

import path from "node:path";
import { stat } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import type { ProjectRegistration } from "../domain/types.js";
import { projectKeyFor } from "../home.js";

export type ProjectService = {
  add(controlRoot: string): Promise<ProjectRegistration>;
  get(projectKey: string): Promise<ProjectRegistration>;
  resolve(input: { projectKey?: string; repository?: string }): Promise<ProjectRegistration>;
  list(): Promise<ProjectRegistration[]>;
};

export function createProjectService(ctx: Context): ProjectService {
  return {
    async add(controlRoot) {
      const resolved = path.resolve(controlRoot);
      const info = await stat(resolved);
      if (!info.isDirectory()) throw new Error(`${resolved} is not a directory`);
      const projectKey = projectKeyFor(resolved);
      const existing = await ctx.store.readRegistration(projectKey);
      if (existing) return existing;
      const registration: ProjectRegistration = {
        projectKey,
        controlRoot: resolved,
        worktreeRoot: path.join(ctx.store.home, "projects", projectKey, "worktrees"),
        createdAt: new Date().toISOString(),
      };
      await ctx.store.writeRegistration(registration);
      return registration;
    },
    async get(projectKey) {
      const registration = await ctx.store.readRegistration(projectKey);
      if (!registration) throw new Error(`Unknown project: ${projectKey}`);
      return registration;
    },
    async resolve(input) {
      if (input.projectKey) return this.get(input.projectKey);
      if (input.repository) {
        const key = projectKeyFor(path.resolve(input.repository));
        const registration = await ctx.store.readRegistration(key);
        if (registration) return registration;
        throw new Error(`Repository is not registered: ${input.repository}`);
      }
      const keys = await ctx.store.listProjectKeys();
      if (keys.length === 1 && keys[0]) return this.get(keys[0]);
      throw new Error("Pass --project or --repository; no unique registered project");
    },
    async list() {
      const keys = await ctx.store.listProjectKeys();
      const rows: ProjectRegistration[] = [];
      for (const key of keys) {
        const row = await ctx.store.readRegistration(key);
        if (row) rows.push(row);
      }
      return rows;
    },
  };
}

export const projectsPlugin = Object.assign(
  (ctx: Context) => {
    ctx.provide("projects", createProjectService(ctx));
  },
  { inject: ["store"] },
);

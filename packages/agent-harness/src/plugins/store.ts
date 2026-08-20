import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ProjectRegistration, RunIdentity, RunState } from "../domain/types.js";
import type { ProjectSettings, SettingsAuditEntry } from "../domain/settings.js";
import { ProjectSettingsSchema } from "../domain/settings.js";

export type StoreService = {
  readonly home: string;
  readJson<T>(relativePath: string): Promise<T | undefined>;
  writeJson(relativePath: string, value: unknown): Promise<void>;
  appendJsonl(relativePath: string, value: unknown): Promise<void>;
  readJsonl<T>(relativePath: string): Promise<T[]>;
  listRunIds(): Promise<string[]>;
  listProjectKeys(): Promise<string[]>;
  readIdentity(runId: string): Promise<RunIdentity | undefined>;
  writeIdentity(identity: RunIdentity): Promise<void>;
  readState(runId: string): Promise<RunState | undefined>;
  writeState(state: RunState): Promise<void>;
  deleteRun(runId: string): Promise<void>;
  readRegistration(projectKey: string): Promise<ProjectRegistration | undefined>;
  writeRegistration(registration: ProjectRegistration): Promise<void>;
  readGlobalSettings(): Promise<Partial<ProjectSettings>>;
  writeGlobalSettings(settings: Partial<ProjectSettings>): Promise<void>;
  readProjectSettings(projectKey: string): Promise<Partial<ProjectSettings>>;
  writeProjectSettings(projectKey: string, settings: Partial<ProjectSettings>): Promise<void>;
  appendSettingsAudit(runId: string, entry: SettingsAuditEntry): Promise<void>;
  readSettingsAudit(runId: string): Promise<SettingsAuditEntry[]>;
  writeSession(runId: string, sessionId: string, value: unknown): Promise<void>;
  readSessions<T = unknown>(runId: string): Promise<T[]>;
  writeArtifact(runId: string, name: string, value: unknown): Promise<void>;
  readArtifact<T>(runId: string, name: string): Promise<T | undefined>;
  appendEvent(runId: string, event: unknown): Promise<void>;
};

function assertSafeRunId(runId: string): void {
  if (!runId || runId !== path.basename(runId) || runId.includes("\0")) {
    throw new Error(`Invalid run id: ${runId}`);
  }
}

function parseJsonText<T>(text: string): T {
  return JSON.parse(text.replace(/^\uFEFF/, "")) as T;
}

export function createFileStore(home: string): StoreService {
  const resolve = (...parts: string[]) => path.join(home, ...parts);

  const readJson = async <T>(relativePath: string): Promise<T | undefined> => {
    try {
      return parseJsonText(await readFile(resolve(relativePath), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };

  const writeJson = async (relativePath: string, value: unknown): Promise<void> => {
    const full = resolve(relativePath);
    await mkdir(path.dirname(full), { recursive: true });
    const temp = `${full}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    const { rename } = await import("node:fs/promises");
    await rename(temp, full);
  };

  const appendJsonl = async (relativePath: string, value: unknown): Promise<void> => {
    const full = resolve(relativePath);
    await mkdir(path.dirname(full), { recursive: true });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(full, `${JSON.stringify(value)}\n`, "utf8");
  };

  const readJsonl = async <T>(relativePath: string): Promise<T[]> => {
    try {
      const text = await readFile(resolve(relativePath), "utf8");
      return text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => parseJsonText<T>(line));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };

  const listDirs = async (relativePath: string): Promise<string[]> => {
    try {
      const entries = await readdir(resolve(relativePath), { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };

  return {
    home,
    readJson,
    writeJson,
    appendJsonl,
    readJsonl,
    listRunIds: () => listDirs("runs"),
    listProjectKeys: () => listDirs("projects"),
    readIdentity: (runId) => readJson<RunIdentity>(`runs/${runId}/identity.json`),
    writeIdentity: (identity) => writeJson(`runs/${identity.runId}/identity.json`, identity),
    readState: (runId) => readJson<RunState>(`runs/${runId}/state.json`),
    writeState: (state) => writeJson(`runs/${state.runId}/state.json`, state),
    async deleteRun(runId) {
      assertSafeRunId(runId);
      await rm(resolve("runs", runId), { recursive: true, force: true });
    },
    readRegistration: (projectKey) =>
      readJson<ProjectRegistration>(`projects/${projectKey}/registration.json`),
    writeRegistration: (registration) =>
      writeJson(`projects/${registration.projectKey}/registration.json`, registration),
    async readGlobalSettings() {
      const raw = await readJson<unknown>("settings.json");
      return raw ? ProjectSettingsSchema.partial().parse(raw) : {};
    },
    writeGlobalSettings: (settings) => writeJson("settings.json", settings),
    async readProjectSettings(projectKey) {
      const raw = await readJson<unknown>(`projects/${projectKey}/settings.json`);
      return raw ? ProjectSettingsSchema.partial().parse(raw) : {};
    },
    writeProjectSettings: (projectKey, settings) =>
      writeJson(`projects/${projectKey}/settings.json`, settings),
    appendSettingsAudit: (runId, entry) =>
      appendJsonl(`runs/${runId}/settings-audit.jsonl`, entry),
    readSettingsAudit: (runId) =>
      readJsonl<SettingsAuditEntry>(`runs/${runId}/settings-audit.jsonl`),
    writeSession: (runId, sessionId, value) =>
      writeJson(`runs/${runId}/sessions/${sessionId}.json`, value),
    async readSessions<T>(runId: string) {
      try {
        const names = (await readdir(resolve("runs", runId, "sessions")))
          .filter((name) => name.endsWith(".json"))
          .sort();
        const rows: T[] = [];
        for (const name of names) {
          const row = await readJson<T>(`runs/${runId}/sessions/${name}`);
          if (row !== undefined) rows.push(row);
        }
        return rows;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    writeArtifact: (runId, name, value) => writeJson(`runs/${runId}/artifacts/${name}.json`, value),
    readArtifact: (runId, name) => readJson(`runs/${runId}/artifacts/${name}.json`),
    appendEvent: (runId, event) => appendJsonl(`runs/${runId}/events.jsonl`, event),
  };
}

export function storePlugin(ctx: Context, config: { home: string }): void {
  ctx.provide("store", createFileStore(config.home));
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs.js";

const ENV_FILENAMES = [".env", ".env.local"] as const;

/**
 * Parse a dotenv file body into key/value pairs.
 * Supports blank lines, `#` comments, and optional single/double quotes.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Load `.env` then `.env.local` from `cwd` into `env`.
 * File merge: later files override earlier (`.env.local` wins over `.env`).
 * Apply step: does not override keys already present in `env` (shell/CI win).
 * Returns paths that were successfully read.
 */
export async function loadDotEnvFiles(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const merged: Record<string, string> = {};
  const loaded: string[] = [];
  for (const name of ENV_FILENAMES) {
    const filePath = path.join(cwd, name);
    if (!(await pathExists(filePath))) continue;
    const content = await readFile(filePath, "utf8");
    Object.assign(merged, parseDotEnv(content));
    loaded.push(filePath);
  }
  for (const [key, value] of Object.entries(merged)) {
    if (env[key] === undefined) env[key] = value;
  }
  return loaded;
}

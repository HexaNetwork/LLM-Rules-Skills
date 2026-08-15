import { chmod, mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { CURSOR_API_KEY_SECRET_CONTAINER_PATH } from "./protocol.js";

export { CURSOR_API_KEY_SECRET_CONTAINER_PATH };

/**
 * Persist CURSOR_API_KEY as a host bootstrap secret file (mode 0400 when supported).
 * Prefer this over injecting the key into the container environment so project
 * commands and `docker inspect` env dumps cannot observe it.
 */
export async function writeCursorApiKeySecretFile(
  absolutePath: string,
  apiKey: string,
): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new Error("CURSOR_API_KEY secret is empty");
  }
  await mkdir(path.dirname(absolutePath), { recursive: true });
  try {
    const existing = (await readFile(absolutePath, "utf8")).trim();
    if (existing === trimmed) return;
    // chmod(0400) maps to a genuinely read-only file on Windows. Make an
    // intentional key rotation writable before replacing its contents.
    await chmod(absolutePath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(absolutePath, `${trimmed}\n`, { encoding: "utf8", flag: "w" });
  try {
    await chmod(absolutePath, 0o400);
  } catch {
    // Windows may ignore chmod.
  }
}

export async function readCursorApiKeySecretFile(
  absolutePath: string,
): Promise<string> {
  const raw = await readFile(absolutePath, "utf8");
  const key = raw.trim();
  if (!key) {
    throw new Error(`CURSOR_API_KEY secret at ${absolutePath} is empty`);
  }
  return key;
}

export async function clearCursorApiKeySecretFile(
  absolutePath: string,
): Promise<void> {
  await unlink(absolutePath).catch(() => undefined);
}

/**
 * Resolve the worker Cursor API key: secret file first, then process env.
 * Never place the key into child command environments (see buildCommandEnvironment).
 */
export async function resolveWorkerCursorApiKey(options: {
  secretFilePath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  if (options.secretFilePath) {
    try {
      return await readCursorApiKeySecretFile(options.secretFilePath);
    } catch {
      // Fall through to env for local/dev workers that have not materialized a file.
    }
  }
  const env = options.env ?? process.env;
  const fromEnv = env.CURSOR_API_KEY?.trim();
  return fromEnv || undefined;
}

/**
 * Assert argv for a worker container never injects CURSOR_API_KEY via -e/--env.
 */
export function argvLeaksCursorApiKey(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-e" || arg === "--env") {
      const value = argv[i + 1] ?? "";
      if (/^CURSOR_API_KEY=/i.test(value) || value === "CURSOR_API_KEY") return true;
    }
    if (/^--env=CURSOR_API_KEY=/i.test(arg)) return true;
  }
  return false;
}

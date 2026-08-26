import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Unix launcher scripts that break under Linux when checked out with CRLF on Windows. */
const KNOWN_UNIX_WRAPPERS = ["gradlew", "mvnw"] as const;

/**
 * Rewrites known Unix shell wrappers from CRLF to LF when needed.
 * Windows `core.autocrlf` otherwise produces `#!/bin/sh\\r`, which Linux reports as
 * `./gradlew: not found` even though the file exists.
 */
export async function normalizeShellWrappers(root: string): Promise<string[]> {
  const fixed: string[] = [];
  for (const name of KNOWN_UNIX_WRAPPERS) {
    if (await rewriteCrlfShebangScript(path.join(root, name))) {
      fixed.push(name);
    }
  }
  return fixed;
}

async function rewriteCrlfShebangScript(filePath: string): Promise<boolean> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (bytes.length < 2 || bytes[0] !== 0x23 || bytes[1] !== 0x21) return false;
  if (!bytes.includes(0x0d)) return false;
  const normalized = Buffer.from(
    bytes.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
    "utf8",
  );
  if (Buffer.compare(bytes, normalized) === 0) return false;
  await writeFile(filePath, normalized);
  return true;
}

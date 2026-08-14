import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** 256 bits of entropy, hex-encoded (64 chars). */
export const WORKER_RPC_TOKEN_BYTES = 32 as const;

/**
 * Generate a high-entropy per-run RPC token.
 * Never log or put this in environment variables.
 */
export function generateWorkerRpcToken(): string {
  return randomBytes(WORKER_RPC_TOKEN_BYTES).toString("hex");
}

/** Constant-time equality for tokens (rejects length mismatch without leaking). */
export function tokensEqual(expected: string, provided: string | undefined): boolean {
  if (provided == null) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Redact token-like substrings from diagnostic strings.
 * Prefer never including secrets in logs; this is a backstop for inspect dumps.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

/** Non-reversible fingerprint for durable metadata (not usable as the token). */
export function workerRpcTokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16);
}

export async function readWorkerRpcToken(secretFilePath: string): Promise<string> {
  const raw = await readFile(secretFilePath, "utf8");
  const token = raw.trim();
  if (token.length < 32) {
    throw new Error(`RPC secret at ${secretFilePath} is missing or too short`);
  }
  return token;
}

/**
 * Persist a bootstrap token file (mode 0400 when supported). Production
 * callers place it outside the durable run directory and mount only this file.
 */
export async function writeWorkerRpcTokenFile(
  absolutePath: string,
  token: string,
): Promise<void> {
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${token}\n`, { encoding: "utf8", flag: "w" });
  try {
    await chmod(absolutePath, 0o400);
  } catch {
    // Windows may ignore chmod; still fine as long as the file is not in env/logs.
  }
}

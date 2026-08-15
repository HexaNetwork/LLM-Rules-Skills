import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256 bits of entropy, hex-encoded (64 chars). */
export const WORKER_RPC_TOKEN_BYTES = 32 as const;

/**
 * Generate a high-entropy per-run RPC token.
 * Never log this token.
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


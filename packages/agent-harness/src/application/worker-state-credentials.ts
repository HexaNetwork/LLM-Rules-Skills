import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUN_STATE_API_PROTOCOL_VERSION } from "../worker/state-protocol.js";

/**
 * Host-side issuer for the per-run, short-lived worker state credential
 * (ADR 0016, plan Phase 3). Each credential is bound to exactly one run ID
 * and one state-protocol version. Records live OUTSIDE the run directory
 * (`<stateRoot>/worker-credentials/<runId>.json`) so a worker with run-state
 * access can never read or rotate its own credential; only the SHA-256 hash
 * of the token is persisted. Delivery to the worker (bootstrap secret) is
 * wired in a later slice.
 */

export const WORKER_STATE_CREDENTIAL_VERSION = 1 as const;

/** Default credential lifetime; the host re-issues on worker recreation. */
export const WORKER_STATE_CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1000;

export const WORKER_BROKER_CAPABILITIES = ["model"] as const;
export type WorkerBrokerCapability = (typeof WORKER_BROKER_CAPABILITIES)[number];

export type WorkerStateCredential = {
  version: typeof WORKER_STATE_CREDENTIAL_VERSION;
  runId: string;
  protocolVersion: number;
  /** SHA-256 of the bearer token; the plaintext token is never persisted. */
  tokenHash: string;
  workerInstanceId?: string;
  capabilities: WorkerBrokerCapability[];
  issuedAt: string;
  expiresAt: string;
};

export type IssuedWorkerStateCredential = {
  /** The plaintext bearer token, returned once at issuance. Never logged. */
  token: string;
  credential: WorkerStateCredential;
};

export type WorkerStateCredentialVerifyResult =
  | { ok: true; credential: WorkerStateCredential }
  | { ok: false; reason: "unknown_token" | "wrong_run" | "expired" | "protocol_mismatch" };

export class WorkerStateCredentialIssuer {
  private readonly now: () => Date;

  constructor(
    private readonly directory: string,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Mint a fresh credential for a run, replacing any previous one. */
  async issue(
    runId: string,
    options: { workerInstanceId?: string; ttlMs?: number } = {},
  ): Promise<IssuedWorkerStateCredential> {
    const token = randomBytes(32).toString("hex");
    const issuedAt = this.now();
    const credential: WorkerStateCredential = {
      version: WORKER_STATE_CREDENTIAL_VERSION,
      runId,
      protocolVersion: RUN_STATE_API_PROTOCOL_VERSION,
      tokenHash: hashToken(token),
      ...(options.workerInstanceId ? { workerInstanceId: options.workerInstanceId } : {}),
      capabilities: [...WORKER_BROKER_CAPABILITIES],
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(
        issuedAt.getTime() + Math.max(1, options.ttlMs ?? WORKER_STATE_CREDENTIAL_TTL_MS),
      ).toISOString(),
    };
    await mkdir(this.directory, { recursive: true });
    const file = this.credentialPath(runId);
    // A previous record may be read-only (chmod 0400); remove before rewrite.
    await rm(file, { force: true });
    await writeFile(file, `${JSON.stringify(credential, null, 2)}\n`, "utf8");
    try {
      await chmod(file, 0o400);
    } catch {
      // Windows may ignore chmod; the file still lives outside the run directory.
    }
    return { token, credential };
  }

  /**
   * Verify a presented token for a run. Distinguishes an unknown token (401)
   * from a valid credential scoped to a different run (403) so cross-run
   * credential use is visible rather than indistinguishable from noise.
   */
  async verify(runId: string, token: string | undefined): Promise<WorkerStateCredentialVerifyResult> {
    if (!token) return { ok: false, reason: "unknown_token" };
    const presented = hashToken(token);
    const match = await this.findByTokenHash(presented);
    if (!match) return { ok: false, reason: "unknown_token" };
    if (match.runId !== runId) return { ok: false, reason: "wrong_run" };
    if (match.protocolVersion !== RUN_STATE_API_PROTOCOL_VERSION) {
      return { ok: false, reason: "protocol_mismatch" };
    }
    if (Date.parse(match.expiresAt) <= this.now().getTime()) {
      return { ok: false, reason: "expired" };
    }
    return { ok: true, credential: match };
  }

  /** Load the current credential record for a run, when one exists. */
  async current(runId: string): Promise<WorkerStateCredential | undefined> {
    try {
      return parseCredential(await readFile(this.credentialPath(runId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** Revoke the run's credential (worker shutdown, run cleanup). */
  async revoke(runId: string): Promise<void> {
    await rm(this.credentialPath(runId), { force: true });
  }

  private credentialPath(runId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
      throw new Error(`Invalid run ID for credential storage: ${JSON.stringify(runId)}`);
    }
    return path.join(this.directory, `${runId}.json`);
  }

  private async findByTokenHash(tokenHash: string): Promise<WorkerStateCredential | undefined> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      let credential: WorkerStateCredential;
      try {
        credential = parseCredential(await readFile(path.join(this.directory, entry), "utf8"));
      } catch {
        continue; // unreadable or malformed records never authenticate
      }
      if (hashesEqual(credential.tokenHash, tokenHash)) return credential;
    }
    return undefined;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time hash comparison (both sides are fixed-length hex digests). */
function hashesEqual(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function parseCredential(raw: string): WorkerStateCredential {
  const value: unknown = JSON.parse(raw);
  const record = value as Partial<WorkerStateCredential> | null;
  if (
    !record ||
    record.version !== WORKER_STATE_CREDENTIAL_VERSION ||
    typeof record.runId !== "string" ||
    typeof record.protocolVersion !== "number" ||
    typeof record.tokenHash !== "string" ||
    typeof record.issuedAt !== "string" ||
    typeof record.expiresAt !== "string"
  ) {
    throw new Error("Malformed worker state credential record");
  }
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.filter((item): item is WorkerBrokerCapability =>
        WORKER_BROKER_CAPABILITIES.includes(item as WorkerBrokerCapability),
      )
    : [...WORKER_BROKER_CAPABILITIES];
  return { ...(record as WorkerStateCredential), capabilities };
}

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PROVIDER_API_PROTOCOL_VERSION } from "../worker/provider-protocol.js";

export const WORKER_PROVIDER_CREDENTIAL_VERSION = 1 as const;
export const WORKER_PROVIDER_CREDENTIAL_TTL_MS = 15 * 60 * 1000;

export type WorkerProviderCredential = {
  version: typeof WORKER_PROVIDER_CREDENTIAL_VERSION;
  provider: "cursor";
  runId: string;
  workerInstanceId: string;
  protocolVersion: typeof PROVIDER_API_PROTOCOL_VERSION;
  tokenHash: string;
  generation: number;
  issuedAt: string;
  expiresAt: string;
};

export type IssuedWorkerProviderCredential = {
  token: string;
  credential: WorkerProviderCredential;
};

export type WorkerProviderCredentialVerifyResult =
  | { ok: true; credential: WorkerProviderCredential }
  | {
      ok: false;
      reason:
        | "unknown_token"
        | "wrong_run"
        | "wrong_worker"
        | "wrong_provider"
        | "expired"
        | "protocol_mismatch";
    };

export class WorkerProviderCredentialIssuer {
  private readonly now: () => Date;

  constructor(
    private readonly directory: string,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async issue(
    runId: string,
    options: { workerInstanceId: string; ttlMs?: number },
  ): Promise<IssuedWorkerProviderCredential> {
    assertIdentifier(runId, "run ID");
    assertIdentifier(options.workerInstanceId, "worker instance ID");
    const current = await this.current(runId);
    const token = randomBytes(32).toString("base64url");
    const issuedAt = this.now();
    const credential: WorkerProviderCredential = {
      version: WORKER_PROVIDER_CREDENTIAL_VERSION,
      provider: "cursor",
      runId,
      workerInstanceId: options.workerInstanceId,
      protocolVersion: PROVIDER_API_PROTOCOL_VERSION,
      tokenHash: hashToken(token),
      generation: (current?.generation ?? 0) + 1,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(
        issuedAt.getTime() + Math.max(1, options.ttlMs ?? WORKER_PROVIDER_CREDENTIAL_TTL_MS),
      ).toISOString(),
    };
    await mkdir(this.directory, { recursive: true });
    const file = this.credentialPath(runId);
    await rm(file, { force: true });
    await writeFile(file, `${JSON.stringify(credential, null, 2)}\n`, "utf8");
    await chmod(file, 0o400).catch(() => undefined);
    return { token, credential };
  }

  /**
   * Atomically replace a still-valid generation. Verification happens before
   * the old record is removed; a failed renewal leaves the current token valid.
   */
  async renew(input: {
    runId: string;
    workerInstanceId: string;
    token: string;
    ttlMs?: number;
  }): Promise<IssuedWorkerProviderCredential> {
    const verification = await this.verify({
      runId: input.runId,
      workerInstanceId: input.workerInstanceId,
      token: input.token,
      protocolVersion: PROVIDER_API_PROTOCOL_VERSION,
      provider: "cursor",
    });
    if (!verification.ok) {
      throw new Error(`Provider credential renewal denied: ${verification.reason}`);
    }
    return this.issue(input.runId, {
      workerInstanceId: input.workerInstanceId,
      ttlMs: input.ttlMs,
    });
  }

  async verify(input: {
    runId: string;
    token?: string;
    workerInstanceId?: string;
    provider?: string;
    protocolVersion?: number;
  }): Promise<WorkerProviderCredentialVerifyResult> {
    if (!input.token) return { ok: false, reason: "unknown_token" };
    const match = await this.findByTokenHash(hashToken(input.token));
    if (!match) return { ok: false, reason: "unknown_token" };
    if (match.runId !== input.runId) return { ok: false, reason: "wrong_run" };
    if (input.workerInstanceId && match.workerInstanceId !== input.workerInstanceId) {
      return { ok: false, reason: "wrong_worker" };
    }
    if ((input.provider ?? "cursor") !== match.provider) {
      return { ok: false, reason: "wrong_provider" };
    }
    if (
      input.protocolVersion !== PROVIDER_API_PROTOCOL_VERSION ||
      match.protocolVersion !== PROVIDER_API_PROTOCOL_VERSION
    ) {
      return { ok: false, reason: "protocol_mismatch" };
    }
    if (Date.parse(match.expiresAt) <= this.now().getTime()) {
      return { ok: false, reason: "expired" };
    }
    return { ok: true, credential: match };
  }

  async current(runId: string): Promise<WorkerProviderCredential | undefined> {
    try {
      return parseCredential(await readFile(this.credentialPath(runId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async revoke(runId: string): Promise<void> {
    await rm(this.credentialPath(runId), { force: true });
  }

  private credentialPath(runId: string): string {
    assertIdentifier(runId, "run ID");
    return path.join(this.directory, `${runId}.json`);
  }

  private async findByTokenHash(tokenHash: string): Promise<WorkerProviderCredential | undefined> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const credential = parseCredential(await readFile(path.join(this.directory, entry), "utf8"));
        if (hashesEqual(credential.tokenHash, tokenHash)) return credential;
      } catch {
        // Malformed records never authenticate.
      }
    }
    return undefined;
  }
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid ${label} for provider credential storage`);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function hashesEqual(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(presented, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCredential(raw: string): WorkerProviderCredential {
  const record = JSON.parse(raw) as Partial<WorkerProviderCredential> | null;
  if (
    !record ||
    record.version !== WORKER_PROVIDER_CREDENTIAL_VERSION ||
    record.provider !== "cursor" ||
    typeof record.runId !== "string" ||
    typeof record.workerInstanceId !== "string" ||
    record.protocolVersion !== PROVIDER_API_PROTOCOL_VERSION ||
    typeof record.tokenHash !== "string" ||
    typeof record.generation !== "number" ||
    typeof record.issuedAt !== "string" ||
    typeof record.expiresAt !== "string"
  ) {
    throw new Error("Malformed worker provider credential record");
  }
  return record as WorkerProviderCredential;
}

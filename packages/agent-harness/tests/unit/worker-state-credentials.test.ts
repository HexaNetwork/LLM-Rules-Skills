import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkerStateCredentialIssuer,
} from "../../src/application/worker-state-credentials.js";
import { RUN_STATE_API_PROTOCOL_VERSION } from "../../src/worker/state-protocol.js";

describe("WorkerStateCredentialIssuer", () => {
  let directory: string;
  let issuer: WorkerStateCredentialIssuer;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "worker-state-credentials-"));
    issuer = new WorkerStateCredentialIssuer(directory);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("issues a credential bound to one run ID and the state protocol version", async () => {
    const { token, credential } = await issuer.issue("run-a", {
      workerInstanceId: "worker-1",
    });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(credential.runId).toBe("run-a");
    expect(credential.protocolVersion).toBe(RUN_STATE_API_PROTOCOL_VERSION);
    expect(credential.workerInstanceId).toBe("worker-1");
    expect(Date.parse(credential.expiresAt)).toBeGreaterThan(Date.parse(credential.issuedAt));

    const verified = await issuer.verify("run-a", token);
    expect(verified).toMatchObject({ ok: true, credential: { runId: "run-a" } });
  });

  it("persists only the token hash, never the plaintext token", async () => {
    const { token } = await issuer.issue("run-a");
    const raw = await readFile(path.join(directory, "run-a.json"), "utf8");
    expect(raw).not.toContain(token);
    expect(JSON.parse(raw).tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects unknown and missing tokens", async () => {
    await issuer.issue("run-a");
    await expect(issuer.verify("run-a", "f".repeat(64))).resolves.toEqual({
      ok: false,
      reason: "unknown_token",
    });
    await expect(issuer.verify("run-a", undefined)).resolves.toEqual({
      ok: false,
      reason: "unknown_token",
    });
  });

  it("rejects a credential presented for a different run", async () => {
    const { token } = await issuer.issue("run-a");
    await issuer.issue("run-b");
    await expect(issuer.verify("run-b", token)).resolves.toEqual({
      ok: false,
      reason: "wrong_run",
    });
  });

  it("rejects an expired credential", async () => {
    let now = new Date("2026-08-14T12:00:00.000Z");
    issuer = new WorkerStateCredentialIssuer(directory, { now: () => now });
    const { token } = await issuer.issue("run-a", { ttlMs: 1_000 });
    now = new Date("2026-08-14T12:00:02.000Z");
    await expect(issuer.verify("run-a", token)).resolves.toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("re-issuing replaces the previous credential for the run", async () => {
    const first = await issuer.issue("run-a");
    const second = await issuer.issue("run-a");
    expect(second.token).not.toBe(first.token);
    await expect(issuer.verify("run-a", first.token)).resolves.toEqual({
      ok: false,
      reason: "unknown_token",
    });
    await expect(issuer.verify("run-a", second.token)).resolves.toMatchObject({ ok: true });
  });

  it("revokes a credential idempotently", async () => {
    const { token } = await issuer.issue("run-a");
    await issuer.revoke("run-a");
    await expect(issuer.verify("run-a", token)).resolves.toEqual({
      ok: false,
      reason: "unknown_token",
    });
    await issuer.revoke("run-a");
  });

  it("refuses run IDs that are unsafe as file names", async () => {
    await expect(issuer.issue("../escape")).rejects.toThrow(/Invalid run ID/);
  });
});

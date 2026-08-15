import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkerProviderCredentialIssuer,
} from "../../src/application/worker-provider-credentials.js";
import { PROVIDER_API_PROTOCOL_VERSION } from "../../src/worker/provider-protocol.js";

describe("WorkerProviderCredentialIssuer", () => {
  let directory: string;
  let now: Date;
  let issuer: WorkerProviderCredentialIssuer;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "worker-provider-"));
    now = new Date("2026-08-15T00:00:00.000Z");
    issuer = new WorkerProviderCredentialIssuer(directory, { now: () => now });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("issues 256-bit run/worker/provider/protocol-scoped capabilities", async () => {
    const issued = await issuer.issue("run-a", { workerInstanceId: "worker-a" });
    expect(Buffer.from(issued.token, "base64url")).toHaveLength(32);
    expect(issued.credential).toMatchObject({
      provider: "cursor",
      runId: "run-a",
      workerInstanceId: "worker-a",
      protocolVersion: PROVIDER_API_PROTOCOL_VERSION,
      generation: 1,
    });
    await expect(
      issuer.verify({
        runId: "run-a",
        workerInstanceId: "worker-a",
        token: issued.token,
        provider: "cursor",
        protocolVersion: PROVIDER_API_PROTOCOL_VERSION,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("persists only a hash and rotates the generation", async () => {
    const first = await issuer.issue("run-a", { workerInstanceId: "worker-a" });
    const raw = await readFile(path.join(directory, "run-a.json"), "utf8");
    expect(raw).not.toContain(first.token);
    expect(JSON.parse(raw).tokenHash).toMatch(/^[a-f0-9]{64}$/);
    const second = await issuer.issue("run-a", { workerInstanceId: "worker-b" });
    expect(second.credential.generation).toBe(2);
    await expect(
      issuer.verify({
        runId: "run-a",
        token: first.token,
        protocolVersion: PROVIDER_API_PROTOCOL_VERSION,
      }),
    ).resolves.toEqual({ ok: false, reason: "unknown_token" });
  });

  it("replaces a valid token during renewal and revokes the prior generation", async () => {
    const first = await issuer.issue("run-a", { workerInstanceId: "worker-a" });
    const renewed = await issuer.renew({
      runId: "run-a",
      workerInstanceId: "worker-a",
      token: first.token,
    });
    expect(renewed.credential.generation).toBe(2);
    expect(renewed.token).not.toBe(first.token);
    await expect(
      issuer.verify({
        runId: "run-a",
        workerInstanceId: "worker-a",
        token: first.token,
        protocolVersion: PROVIDER_API_PROTOCOL_VERSION,
      }),
    ).resolves.toEqual({ ok: false, reason: "unknown_token" });
    await expect(
      issuer.verify({
        runId: "run-a",
        workerInstanceId: "worker-a",
        token: renewed.token,
        protocolVersion: PROVIDER_API_PROTOCOL_VERSION,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("rejects cross-run, cross-worker, wrong-protocol, expired, and revoked use", async () => {
    const issued = await issuer.issue("run-a", { workerInstanceId: "worker-a", ttlMs: 100 });
    await issuer.issue("run-b", { workerInstanceId: "worker-b" });
    await expect(
      issuer.verify({
        runId: "run-b",
        token: issued.token,
        protocolVersion: PROVIDER_API_PROTOCOL_VERSION,
      }),
    ).resolves.toEqual({ ok: false, reason: "wrong_run" });
    await expect(
      issuer.verify({
        runId: "run-a",
        workerInstanceId: "worker-z",
        token: issued.token,
        protocolVersion: PROVIDER_API_PROTOCOL_VERSION,
      }),
    ).resolves.toEqual({ ok: false, reason: "wrong_worker" });
    await expect(
      issuer.verify({ runId: "run-a", token: issued.token, protocolVersion: 999 }),
    ).resolves.toEqual({ ok: false, reason: "protocol_mismatch" });
    now = new Date(now.getTime() + 101);
    await expect(
      issuer.verify({
        runId: "run-a",
        token: issued.token,
        protocolVersion: PROVIDER_API_PROTOCOL_VERSION,
      }),
    ).resolves.toEqual({ ok: false, reason: "expired" });
    await issuer.revoke("run-a");
    await expect(
      issuer.verify({
        runId: "run-a",
        token: issued.token,
        protocolVersion: PROVIDER_API_PROTOCOL_VERSION,
      }),
    ).resolves.toEqual({ ok: false, reason: "unknown_token" });
  });
});

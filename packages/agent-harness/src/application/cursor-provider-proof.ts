import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HarnessFailure } from "../errors.js";
import {
  CURSOR_PROVIDER_CONTRACT_VERSION,
  CURSOR_PROVIDER_PROXY_VERSION,
  PINNED_CURSOR_SDK_VERSION,
} from "../infrastructure/provider-proxy/cursor-provider-contract.js";
import { PROVIDER_API_PROTOCOL_VERSION } from "../worker/provider-protocol.js";
import type {
  CursorProviderCredentialAbsenceEvidence,
  SafeSdkDiagnostic,
  SmokeLifecycleStageEvidence,
} from "./cursor-provider-sdk-smoke-child.js";

const CACHE_FILENAME = "cursor-provider-proofs.json";

export type CursorProviderProofTuple = {
  imageDigest: string;
  sdkVersion: string;
  providerProtocolVersion: number;
  contractVersion: string;
  proxyVersion: string;
  model: string;
  tlsIdentity: string;
  keyFingerprint: string;
};

export type CursorProviderProofReport = {
  version: 1;
  ok: boolean;
  unsupported: boolean;
  tuple: CursorProviderProofTuple;
  provedAt: string;
  checks: Array<{ id: string; ok: boolean; detail: string }>;
  operations?: Array<{
    method: string;
    path: string;
    operation: string;
    status: number;
    requestBytes: number;
    responseBytes: number;
    durationMs: number;
    streaming?: true;
    contentType?: "application/connect+proto" | "application/connect+json";
    failure?: string;
  }>;
  lifecycle?: {
    create: boolean;
    send: boolean;
    stream: boolean;
    wait: boolean;
    resume: boolean;
    cancel: boolean;
    dispose: boolean;
  };
  credentialAbsence?: CursorProviderCredentialAbsenceEvidence;
  sdkDiagnostics?: SafeSdkDiagnostic[];
  lifecycleStages?: SmokeLifecycleStageEvidence[];
  reason?: string;
};

export type CursorProviderProofCache = {
  version: 1;
  updatedAt: string;
  entries: CursorProviderProofReport[];
};

export function cursorProviderKeyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey.trim()).digest("hex").slice(0, 16);
}

export function currentCursorProviderProofTuple(input: {
  imageDigest: string;
  model: string;
  tlsIdentity: string;
  apiKey: string;
}): CursorProviderProofTuple {
  return {
    imageDigest: input.imageDigest.trim(),
    sdkVersion: PINNED_CURSOR_SDK_VERSION,
    providerProtocolVersion: PROVIDER_API_PROTOCOL_VERSION,
    contractVersion: CURSOR_PROVIDER_CONTRACT_VERSION,
    proxyVersion: CURSOR_PROVIDER_PROXY_VERSION,
    model: input.model.trim(),
    tlsIdentity: input.tlsIdentity,
    keyFingerprint: cursorProviderKeyFingerprint(input.apiKey),
  };
}

export function cursorProviderProofCacheKey(tuple: CursorProviderProofTuple): string {
  return createHash("sha256").update(JSON.stringify(tuple)).digest("hex");
}

export async function loadCursorProviderProofCache(
  projectStateRoot: string,
): Promise<CursorProviderProofCache> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(projectStateRoot, CACHE_FILENAME), "utf8"),
    ) as CursorProviderProofCache;
    if (parsed.version === 1 && Array.isArray(parsed.entries)) return parsed;
  } catch {
    // Missing and malformed evidence fail closed.
  }
  return { version: 1, updatedAt: new Date(0).toISOString(), entries: [] };
}

export async function saveCursorProviderProofCache(
  projectStateRoot: string,
  cache: CursorProviderProofCache,
): Promise<void> {
  await mkdir(projectStateRoot, { recursive: true });
  await writeFile(
    path.join(projectStateRoot, CACHE_FILENAME),
    `${JSON.stringify(cache, null, 2)}\n`,
    "utf8",
  );
}

export async function recordCursorProviderProof(
  projectStateRoot: string,
  report: CursorProviderProofReport,
): Promise<void> {
  const cache = await loadCursorProviderProofCache(projectStateRoot);
  const key = cursorProviderProofCacheKey(report.tuple);
  const entries = cache.entries.filter(
    (entry) => cursorProviderProofCacheKey(entry.tuple) !== key,
  );
  entries.push(report);
  await saveCursorProviderProofCache(projectStateRoot, {
    version: 1,
    updatedAt: report.provedAt,
    entries,
  });
}

export function findMatchingCursorProviderProof(
  cache: CursorProviderProofCache,
  tuple: CursorProviderProofTuple,
): CursorProviderProofReport | undefined {
  const key = cursorProviderProofCacheKey(tuple);
  return cache.entries.find(
    (entry) =>
      entry.ok &&
      !entry.unsupported &&
      cursorProviderProofCacheKey(entry.tuple) === key,
  );
}

export function assertCursorProviderProofPassed(
  report: CursorProviderProofReport | undefined,
  tuple: CursorProviderProofTuple,
): CursorProviderProofReport {
  if (report?.ok && !report.unsupported && cursorProviderProofCacheKey(report.tuple) === cursorProviderProofCacheKey(tuple)) {
    return report;
  }
  throw new HarnessFailure(
    `Real Cursor runs are blocked: no matching green host provider-proxy proof exists for ${tuple.imageDigest}. ` +
      `Run \`agent-harness execution cursor-provider-smoke --repository <path> --force\`.`,
    "execution",
    false,
  );
}

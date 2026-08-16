import { describe, expect, it } from "vitest";
import {
  assertCursorProviderProofPassed,
  currentCursorProviderProofTuple,
  cursorProviderProofCacheKey,
  findMatchingCursorProviderProof,
  type CursorProviderProofCache,
  type CursorProviderProofReport,
} from "../../src/application/cursor-provider-proof.js";

describe("Cursor provider proof gate", () => {
  const tuple = currentCursorProviderProofTuple({
    imageDigest: "sha256:image",
    model: "cursor-model",
    tlsIdentity: "sha256:tls",
  });
  const report: CursorProviderProofReport = {
    version: 1,
    ok: true,
    unsupported: false,
    tuple,
    provedAt: "2026-08-15T00:00:00.000Z",
    checks: [{ id: "host-only-key", ok: true, detail: "redacted" }],
  };
  const cache: CursorProviderProofCache = {
    version: 1,
    updatedAt: report.provedAt,
    entries: [report],
  };

  it("accepts only an exact green compatibility tuple", () => {
    expect(findMatchingCursorProviderProof(cache, tuple)).toBe(report);
    expect(assertCursorProviderProofPassed(report, tuple)).toBe(report);
    for (const changed of [
      { ...tuple, imageDigest: "sha256:other" },
      { ...tuple, sdkVersion: "other-sdk" },
      { ...tuple, providerProtocolVersion: tuple.providerProtocolVersion + 1 },
      { ...tuple, contractVersion: "other-contract" },
      { ...tuple, proxyVersion: "other-proxy" },
      { ...tuple, model: "other-model" },
      { ...tuple, tlsIdentity: "sha256:rotated" },
    ]) {
      expect(findMatchingCursorProviderProof(cache, changed)).toBeUndefined();
      expect(() => assertCursorProviderProofPassed(report, changed)).toThrow(
        /cursor-provider-smoke/,
      );
    }
  });

  it("reuses proof across key rotation and harness launches without storing key identity", () => {
    const historicalTuple = {
      ...tuple,
      keyFingerprint: "0123456789abcdef",
    };
    const historicalReport = {
      ...report,
      tuple: historicalTuple,
      provedAt: "2020-01-01T00:00:00.000Z",
    };
    const reloadedCache = {
      ...cache,
      entries: [historicalReport],
    };

    expect(cursorProviderProofCacheKey(historicalTuple)).toBe(
      cursorProviderProofCacheKey(tuple),
    );
    expect(findMatchingCursorProviderProof(reloadedCache, tuple)).toBe(historicalReport);
    expect(JSON.stringify(tuple)).not.toContain("keyFingerprint");
  });

  it("rejects missing, failed, and unsupported reports", () => {
    expect(() => assertCursorProviderProofPassed(undefined, tuple)).toThrow(/blocked/i);
    expect(() => assertCursorProviderProofPassed({ ...report, ok: false }, tuple)).toThrow();
    expect(() =>
      assertCursorProviderProofPassed({ ...report, unsupported: true }, tuple),
    ).toThrow();
  });
});

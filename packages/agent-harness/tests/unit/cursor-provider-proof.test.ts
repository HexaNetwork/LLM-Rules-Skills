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
    apiKey: "host-key",
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
    expect(
      findMatchingCursorProviderProof(cache, { ...tuple, imageDigest: "sha256:other" }),
    ).toBeUndefined();
    expect(() =>
      assertCursorProviderProofPassed(report, { ...tuple, tlsIdentity: "sha256:rotated" }),
    ).toThrow(/cursor-provider-smoke/);
  });

  it("invalidates evidence on key rotation without exposing key bytes", () => {
    const rotated = currentCursorProviderProofTuple({
      imageDigest: tuple.imageDigest,
      model: tuple.model,
      tlsIdentity: tuple.tlsIdentity,
      apiKey: "rotated-host-key",
    });
    expect(cursorProviderProofCacheKey(rotated)).not.toBe(cursorProviderProofCacheKey(tuple));
    expect(JSON.stringify(tuple)).not.toContain("host-key");
  });

  it("rejects missing, failed, and unsupported reports", () => {
    expect(() => assertCursorProviderProofPassed(undefined, tuple)).toThrow(/blocked/i);
    expect(() => assertCursorProviderProofPassed({ ...report, ok: false }, tuple)).toThrow();
    expect(() =>
      assertCursorProviderProofPassed({ ...report, unsupported: true }, tuple),
    ).toThrow();
  });
});

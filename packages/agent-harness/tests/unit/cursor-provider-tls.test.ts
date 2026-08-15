import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURSOR_PROVIDER_CA_CONTAINER_PATH,
  cursorProviderTlsIdentityFromCertificate,
  ensureCursorProviderTlsMaterial,
  readCursorProviderTlsIdentity,
} from "../../src/infrastructure/provider-proxy/tls.js";

describe("Cursor provider TLS material", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("creates and reloads a host-owned CA and host.docker.internal leaf", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "cursor-provider-tls-"));
    const first = await ensureCursorProviderTlsMaterial(directory);
    const second = await ensureCursorProviderTlsMaterial(directory);
    const leaf = new X509Certificate(first.serverCertificate);
    const ca = new X509Certificate(first.caCertificate);

    expect(leaf.checkHost("host.docker.internal")).toBe("host.docker.internal");
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(second.tlsIdentity).toBe(first.tlsIdentity);
    expect(await readCursorProviderTlsIdentity(directory)).toBe(first.tlsIdentity);
    expect(cursorProviderTlsIdentityFromCertificate(first.caCertificate)).toBe(
      first.tlsIdentity,
    );
    expect(await readFile(first.caCertificatePath, "utf8")).toBe(first.caCertificate);
    expect(CURSOR_PROVIDER_CA_CONTAINER_PATH).not.toMatch(/secret/i);
  });
});

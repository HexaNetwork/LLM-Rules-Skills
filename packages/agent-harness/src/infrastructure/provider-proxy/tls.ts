import { createHash, X509Certificate } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import selfsigned from "selfsigned";

const TLS_MATERIAL_VERSION = 1 as const;
const CA_CERTIFICATE_FILE = "ca-cert.pem";
const CA_PRIVATE_KEY_FILE = "ca-key.pem";
const SERVER_CERTIFICATE_FILE = "server-cert.pem";
const SERVER_PRIVATE_KEY_FILE = "server-key.pem";
const MANIFEST_FILE = "manifest.json";

export const CURSOR_PROVIDER_CA_CONTAINER_PATH =
  "/run/agent-harness-public/cursor-provider-ca.pem" as const;

type CursorProviderTlsManifest = {
  version: typeof TLS_MATERIAL_VERSION;
  hostname: string;
  tlsIdentity: string;
  notAfter: string;
};

export type CursorProviderTlsMaterial = {
  caCertificatePath: string;
  caCertificate: string;
  serverCertificate: string;
  serverPrivateKey: string;
  hostname: string;
  tlsIdentity: string;
  notAfter: string;
};

export async function readCursorProviderTlsIdentity(
  directory: string,
): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(directory, MANIFEST_FILE), "utf8"),
    ) as CursorProviderTlsManifest;
    const caCertificate = await readFile(path.join(directory, CA_CERTIFICATE_FILE), "utf8");
    return manifest.version === TLS_MATERIAL_VERSION &&
      manifest.tlsIdentity === certificateIdentity(caCertificate)
      ? manifest.tlsIdentity
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load or create a host-owned CA and a server leaf for host.docker.internal.
 * Only the public CA path may be delivered to a worker.
 */
export async function ensureCursorProviderTlsMaterial(
  directory: string,
  options: { hostname?: string; now?: () => Date } = {},
): Promise<CursorProviderTlsMaterial> {
  const hostname = options.hostname ?? "host.docker.internal";
  const now = options.now?.() ?? new Date();
  const loaded = await loadTlsMaterial(directory, hostname, now);
  if (loaded) return loaded;

  await mkdir(directory, { recursive: true });
  const caNotAfter = new Date(now);
  caNotAfter.setUTCFullYear(caNotAfter.getUTCFullYear() + 5);
  const serverNotAfter = new Date(now);
  serverNotAfter.setUTCFullYear(serverNotAfter.getUTCFullYear() + 1);

  const ca = await selfsigned.generate(
    [{ name: "commonName", value: "Agent Harness Cursor Provider CA" }],
    {
      keyType: "ec",
      curve: "P-256",
      algorithm: "sha256",
      notBeforeDate: new Date(now.getTime() - 60_000),
      notAfterDate: caNotAfter,
      extensions: [
        { name: "basicConstraints", cA: true, pathLenConstraint: 0, critical: true },
        {
          name: "keyUsage",
          keyCertSign: true,
          cRLSign: true,
          digitalSignature: true,
          critical: true,
        },
      ],
    },
  );
  const server = await selfsigned.generate(
    [{ name: "commonName", value: hostname }],
    {
      keyType: "ec",
      curve: "P-256",
      algorithm: "sha256",
      notBeforeDate: new Date(now.getTime() - 60_000),
      notAfterDate: serverNotAfter,
      ca: { key: ca.private, cert: ca.cert },
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyEncipherment: true,
          critical: true,
        },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [{ type: 2, value: hostname }] },
      ],
    },
  );
  const tlsIdentity = certificateIdentity(ca.cert);
  const manifest: CursorProviderTlsManifest = {
    version: TLS_MATERIAL_VERSION,
    hostname,
    tlsIdentity,
    notAfter: new X509Certificate(server.cert).validTo,
  };

  await Promise.all([
    writePrivate(path.join(directory, CA_PRIVATE_KEY_FILE), ca.private),
    writePrivate(path.join(directory, SERVER_PRIVATE_KEY_FILE), server.private),
    writePublic(path.join(directory, CA_CERTIFICATE_FILE), ca.cert),
    writePublic(path.join(directory, SERVER_CERTIFICATE_FILE), server.cert),
    writePublic(path.join(directory, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`),
  ]);
  return {
    caCertificatePath: path.join(directory, CA_CERTIFICATE_FILE),
    caCertificate: ca.cert,
    serverCertificate: server.cert,
    serverPrivateKey: server.private,
    hostname,
    tlsIdentity,
    notAfter: manifest.notAfter,
  };
}

async function loadTlsMaterial(
  directory: string,
  hostname: string,
  now: Date,
): Promise<CursorProviderTlsMaterial | undefined> {
  try {
    const [manifestRaw, caCertificate, serverCertificate, serverPrivateKey] =
      await Promise.all([
        readFile(path.join(directory, MANIFEST_FILE), "utf8"),
        readFile(path.join(directory, CA_CERTIFICATE_FILE), "utf8"),
        readFile(path.join(directory, SERVER_CERTIFICATE_FILE), "utf8"),
        readFile(path.join(directory, SERVER_PRIVATE_KEY_FILE), "utf8"),
      ]);
    const manifest = JSON.parse(manifestRaw) as CursorProviderTlsManifest;
    const certificate = new X509Certificate(serverCertificate);
    if (
      manifest.version !== TLS_MATERIAL_VERSION ||
      manifest.hostname !== hostname ||
      manifest.tlsIdentity !== certificateIdentity(caCertificate) ||
      Date.parse(certificate.validTo) <= now.getTime() + 24 * 60 * 60 * 1000 ||
      certificate.checkHost(hostname) !== hostname
    ) {
      return undefined;
    }
    return {
      caCertificatePath: path.join(directory, CA_CERTIFICATE_FILE),
      caCertificate,
      serverCertificate,
      serverPrivateKey,
      hostname,
      tlsIdentity: manifest.tlsIdentity,
      notAfter: certificate.validTo,
    };
  } catch {
    return undefined;
  }
}

export function cursorProviderTlsIdentityFromCertificate(certificatePem: string): string {
  const certificate = new X509Certificate(certificatePem);
  return `sha256:${createHash("sha256").update(certificate.raw).digest("hex")}`;
}

const certificateIdentity = cursorProviderTlsIdentityFromCertificate;

async function writePrivate(file: string, value: string): Promise<void> {
  await writeFile(file, value, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600).catch(() => undefined);
}

async function writePublic(file: string, value: string): Promise<void> {
  await writeFile(file, value, { encoding: "utf8", mode: 0o644 });
  await chmod(file, 0o644).catch(() => undefined);
}

/**
 * Independently versioned worker-to-host provider broker contract.
 *
 * The broker token is intentionally agent-readable: it is a short-lived,
 * run-scoped capability and is never the upstream Cursor credential.
 */
export const PROVIDER_API_PROTOCOL_VERSION = 1 as const;
export const PROVIDER_API_PREFIX = "/provider-api" as const;
export const PROVIDER_API_AUTH_HEADER = "x-harness-provider-token" as const;
export const PROVIDER_API_PROTOCOL_HEADER = "x-harness-provider-protocol" as const;
export const PROVIDER_API_REQUEST_ID_HEADER = "x-request-id" as const;
export const PROVIDER_API_MAX_BODY_BYTES = 2_000_000 as const;

export type CursorProviderCompatibility = {
  sdkVersion: string;
  contractVersion: string;
  proxyVersion: string;
  tlsIdentity: string;
};

export type WorkerProviderBootstrap = {
  provider: "cursor";
  endpoint: string;
  token: string;
  expiresAt: string;
  protocolVersion: typeof PROVIDER_API_PROTOCOL_VERSION;
  compatibility: CursorProviderCompatibility;
  tls?: {
    caCertificatePath: string;
    tlsIdentity: string;
  };
};

export type ProviderApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "expired"
  | "protocol_mismatch"
  | "method_not_allowed"
  | "route_not_allowed"
  | "body_too_large"
  | "concurrency_limited"
  | "upstream_redirect"
  | "upstream_failure"
  | "broker_unavailable";

export function cursorProviderApiPath(runId: string, relativePath = ""): string {
  const suffix = relativePath.replace(/^\/+/, "");
  return `${PROVIDER_API_PREFIX}/v1/runs/${encodeURIComponent(runId)}/cursor${
    suffix ? `/${suffix}` : ""
  }`;
}

export function assertSafeProviderRelativePath(relativePath: string): string {
  if (
    !relativePath.startsWith("/") ||
    relativePath.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.includes("\0")
  ) {
    throw new Error("Provider path must be an origin-relative URL path");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch {
    throw new Error("Provider path contains malformed percent encoding");
  }
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("Provider path traversal is forbidden");
  }
  return relativePath;
}

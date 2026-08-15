import { assertSafeProviderRelativePath } from "../../worker/provider-protocol.js";

export const CURSOR_PROVIDER_CONTRACT_VERSION = "cursor-sdk-1.0.27-linux-container-v9" as const;
export const CURSOR_PROVIDER_PROXY_VERSION = "5" as const;
export const PINNED_CURSOR_SDK_VERSION = "1.0.27" as const;

export type CursorProviderUpstream = "cloud-api" | "agent-api";

export const CURSOR_PROVIDER_UPSTREAM_ORIGINS = {
  "cloud-api": "https://api.cursor.com/",
  "agent-api": "https://api2.cursor.sh/",
} as const satisfies Record<CursorProviderUpstream, string>;

export type CursorProviderOperation = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  operation: string;
  upstream: CursorProviderUpstream;
  /**
   * "bidirectional": request and response bytes both stream incrementally
   * (BidiAppend upload channel).
   * "server": the request is a small buffered message but the response is a
   * long-lived Connect server-stream that must be forwarded chunk-by-chunk
   * and never buffered to EOF (AgentService RunSSE download channel).
   */
  streaming?: "bidirectional" | "server";
};

export type CursorProviderContract = {
  version: string;
  sdkVersion: string;
  productionReady: boolean;
  operations: readonly CursorProviderOperation[];
};

/**
 * SDK 1.0.27's documented CURSOR_BACKEND_URL seam routes API-key exchange,
 * model discovery, and local AgentService RPCs through the broker origin.
 * Each exact route is then mapped to its installed Cursor origin. New Connect
 * methods remain blocked until the live proof recorder observes and a
 * compatibility update explicitly allows them.
 */
export const UNPROVEN_CURSOR_PROVIDER_CONTRACT: CursorProviderContract = {
  version: CURSOR_PROVIDER_CONTRACT_VERSION,
  sdkVersion: PINNED_CURSOR_SDK_VERSION,
  productionReady: true,
  operations: [
    {
      method: "POST",
      path: "/auth/exchange_user_api_key",
      operation: "auth-exchange",
      upstream: "agent-api",
    },
    {
      method: "GET",
      path: "/v1/models",
      operation: "model-list",
      upstream: "cloud-api",
    },
    {
      method: "POST",
      path: "/agent.v1.AgentService/RunSSE",
      operation: "agent-service",
      upstream: "agent-api",
      streaming: "server",
    },
    {
      method: "POST",
      path: "/aiserver.v1.AgentService/RunSSE",
      operation: "agent-service",
      upstream: "agent-api",
      streaming: "server",
    },
    // ServerConfigService/GetServerConfig is intentionally NOT allowed. SDK
    // 1.0.27 calls it only to fetch an http2Config that selects HTTP/2 bidi
    // versus the HTTP/1.1 BidiAppend+RunSSE bridge. The harness pins
    // local.useHttp1ForAgent=true, denial is non-fatal (the SDK logs and
    // falls back to that pinned default), and allowing it would let a
    // server-side FORCE_*_ENABLED flag flip the SDK to an HTTP/2 transport
    // this HTTP/1.1 proxy does not serve. Live proof v7 confirmed allowing
    // it (200, 12,715 bytes) changed nothing.
    {
      method: "POST",
      path: "/aiserver.v1.BidiService/BidiAppend",
      operation: "agent-service",
      upstream: "agent-api",
      streaming: "bidirectional",
    },
  ],
};

export function classifyCursorProviderOperation(
  contract: CursorProviderContract,
  method: string,
  relativePath: string,
): CursorProviderOperation | undefined {
  const safePath = assertSafeProviderRelativePath(relativePath);
  const upperMethod = method.toUpperCase();
  return contract.operations.find((operation) => {
    if (operation.method !== upperMethod) return false;
    return operation.path === safePath;
  });
}

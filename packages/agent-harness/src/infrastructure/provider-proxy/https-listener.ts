import https from "node:https";
import type { CursorProviderProxy } from "./cursor-provider-proxy.js";
import type { CursorProviderTlsMaterial } from "./tls.js";
import { handleWorkerProviderRoutes } from "../../ui/http/routes/worker-provider.js";

export type CursorProviderHttpsListener = {
  containerOrigin: string;
  port: number;
  tlsIdentity: string;
  close(): Promise<void>;
};

export async function startCursorProviderHttpsListener(input: {
  proxy: CursorProviderProxy;
  tls: CursorProviderTlsMaterial;
  port?: number;
  listenHost?: string;
}): Promise<CursorProviderHttpsListener> {
  const server = https.createServer(
    {
      key: input.tls.serverPrivateKey,
      cert: input.tls.serverCertificate,
      ca: input.tls.caCertificate,
      minVersion: "TLSv1.2",
    },
    async (request, response) => {
      try {
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-content-type-options", "nosniff");
        const url = new URL(request.url ?? "/", `https://${input.tls.hostname}`);
        if (await handleWorkerProviderRoutes(request, response, url, input.proxy)) return;
        response.statusCode = 404;
        response.end('{"ok":false,"error":"route_not_allowed"}\n');
      } catch {
        if (response.headersSent) {
          response.destroy();
        } else {
          response.statusCode = 500;
          response.end('{"ok":false,"error":"broker_unavailable"}\n');
        }
      }
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port ?? 0, input.listenHost ?? "0.0.0.0", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Cursor provider HTTPS listener did not bind a TCP port");
  }
  return {
    containerOrigin: `https://${input.tls.hostname}:${address.port}`,
    port: address.port,
    tlsIdentity: input.tls.tlsIdentity,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

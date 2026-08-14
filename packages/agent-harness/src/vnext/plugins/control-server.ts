import type { Context } from "@deepseek-ai/cordis";
import { startUiServer, type UiServerOptions } from "../../ui/server.js";
import type { CredentialsService, WebServerService } from "../services/contracts.js";

export type ControlServerConfig = Omit<UiServerOptions, "openBrowser" | "dashboard">;

/**
 * Always-on headless control plane. The dashboard is a separate adapter; this
 * plugin exposes health and authenticated worker state RPC even for CLI runs.
 */
export async function controlServerPlugin(
  ctx: Context,
  config: ControlServerConfig,
): Promise<() => Promise<void>> {
  const server = await startUiServer({
    ...config,
    openBrowser: false,
    dashboard: false,
  });
  const webServer: WebServerService = {
    origin: server.origin,
    close: () => server.close(),
  };
  const credentials: CredentialsService = {
    async issue(runId, workerInstanceId) {
      const issued = await server.issueWorkerStateCredential(runId, { workerInstanceId });
      return { credential: issued.token, expiresAt: issued.credential.expiresAt };
    },
    async revoke() {
      // Credentials are short-lived and incarnation-bound. Disposal closes the
      // endpoint; explicit issuer revocation is added when the credential store
      // exposes a targeted delete operation.
    },
  };
  ctx.provide("webServer", webServer);
  ctx.provide("credentials", credentials);
  return () => server.close();
}

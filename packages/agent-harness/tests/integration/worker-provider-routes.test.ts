import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunState } from "../../src/domain.js";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import type { CursorProviderContract } from "../../src/infrastructure/provider-proxy/cursor-provider-contract.js";
import { RunStore } from "../../src/store.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import {
  PROVIDER_API_AUTH_HEADER,
  PROVIDER_API_PROTOCOL_HEADER,
  PROVIDER_API_PROTOCOL_VERSION,
  type WorkerProviderBootstrap,
} from "../../src/worker/provider-protocol.js";
import {
  RUN_STATE_API_AUTH_HEADER,
  RUN_STATE_API_PROTOCOL_HEADER,
  RUN_STATE_API_PROTOCOL_VERSION,
  runStateApiPath,
} from "../../src/worker/state-protocol.js";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";

const CONTRACT: CursorProviderContract = {
  version: "fake-v1",
  sdkVersion: "1.0.27",
  productionReady: false,
  operations: [
    {
      method: "POST",
      path: "/agent/run",
      operation: "agent-run",
      upstream: "agent-api",
    },
  ],
};

describe("worker provider routes", () => {
  let fixture: ProjectFixture | undefined;
  let ui: UiServer | undefined;

  afterEach(async () => {
    await ui?.close();
    await fixture?.cleanup();
  });

  it("bootstraps with state auth then brokers with a distinct scoped token", async () => {
    fixture = await createProjectFixture();
    const store = new RunStore(fixture.config, resolveHarnessPaths(fixture.config).stateRoot);
    await store.initialize();
    await store.create(createRunState("run-a", "provider route", "2026-08-15T00:00:00.000Z"));
    await store.writeJson("run-a", "config.json", fixture.config);
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer host-only-key");
      return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
    });
    ui = await startUiServer({
      config: fixture.config,
      backend: createFakeBackend({}),
      port: 0,
      dashboard: false,
      cursorProviderDevelopment: {
        upstreamOrigins: {
          "cloud-api": "https://cursor.example/",
          "agent-api": "https://cursor.example/",
        },
        apiKey: "host-only-key",
        contract: CONTRACT,
        fetch: fetcher as typeof fetch,
        allowInsecureHttp: true,
      },
    });
    const { token: stateToken } = await ui.issueWorkerStateCredential("run-a", {
      workerInstanceId: "worker-a",
    });
    const bootstrapResponse = await fetch(
      `${ui.origin}${runStateApiPath("run-a", "provider/cursor/bootstrap")}`,
      {
        method: "POST",
        headers: {
          [RUN_STATE_API_AUTH_HEADER]: stateToken,
          [RUN_STATE_API_PROTOCOL_HEADER]: String(RUN_STATE_API_PROTOCOL_VERSION),
        },
        body: "{}",
      },
    );
    expect(bootstrapResponse.status).toBe(200);
    const envelope = (await bootstrapResponse.json()) as {
      result: WorkerProviderBootstrap;
    };
    expect(envelope.result.endpoint).toMatch(/^http:\/\/host\.docker\.internal:/);
    expect(envelope.result.token).not.toBe(stateToken);

    const providerPath = new URL(envelope.result.endpoint).pathname;
    const brokered = await fetch(`${ui.origin}${providerPath}/agent/run`, {
      method: "POST",
      headers: {
        [PROVIDER_API_AUTH_HEADER]: envelope.result.token,
        [PROVIDER_API_PROTOCOL_HEADER]: String(PROVIDER_API_PROTOCOL_VERSION),
        authorization: "Bearer caller-value",
      },
      body: "{}",
    });
    expect(brokered.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();

    const renewalResponse = await fetch(
      `${ui.origin}${runStateApiPath("run-a", "provider/cursor/renew")}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [RUN_STATE_API_AUTH_HEADER]: stateToken,
          [RUN_STATE_API_PROTOCOL_HEADER]: String(RUN_STATE_API_PROTOCOL_VERSION),
        },
        body: JSON.stringify({ token: envelope.result.token }),
      },
    );
    expect(renewalResponse.status).toBe(200);
    const renewed = (await renewalResponse.json()) as { result: WorkerProviderBootstrap };
    expect(renewed.result.token).not.toBe(envelope.result.token);
    const staleToken = await fetch(`${ui.origin}${providerPath}/agent/run`, {
      method: "POST",
      headers: {
        [PROVIDER_API_AUTH_HEADER]: envelope.result.token,
        [PROVIDER_API_PROTOCOL_HEADER]: String(PROVIDER_API_PROTOCOL_VERSION),
      },
      body: "{}",
    });
    expect(staleToken.status).toBe(401);
    const renewedToken = await fetch(`${ui.origin}${providerPath}/agent/run`, {
      method: "POST",
      headers: {
        [PROVIDER_API_AUTH_HEADER]: renewed.result.token,
        [PROVIDER_API_PROTOCOL_HEADER]: String(PROVIDER_API_PROTOCOL_VERSION),
      },
      body: "{}",
    });
    expect(renewedToken.status).toBe(200);

    const stateTokenOnProvider = await fetch(`${ui.origin}${providerPath}/agent/run`, {
      method: "POST",
      headers: {
        [PROVIDER_API_AUTH_HEADER]: stateToken,
        [PROVIDER_API_PROTOCOL_HEADER]: String(PROVIDER_API_PROTOCOL_VERSION),
      },
      body: "{}",
    });
    expect(stateTokenOnProvider.status).toBe(401);
    const providerTokenOnState = await fetch(
      `${ui.origin}${runStateApiPath("run-a", "provider/cursor/bootstrap")}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [RUN_STATE_API_AUTH_HEADER]: envelope.result.token,
          [RUN_STATE_API_PROTOCOL_HEADER]: String(RUN_STATE_API_PROTOCOL_VERSION),
        },
        body: "{}",
      },
    );
    expect(providerTokenOnState.status).toBe(401);
  });
});

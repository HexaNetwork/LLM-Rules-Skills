import { afterEach, describe, expect, it } from "vitest";
import { createRunState } from "../../src/domain.js";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import { RunStore } from "../../src/store.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import {
  RUN_STATE_API_AUTH_HEADER,
  RUN_STATE_API_PROTOCOL_HEADER,
  RUN_STATE_API_PROTOCOL_VERSION,
  runStateApiPath,
} from "../../src/worker/state-protocol.js";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";

const NOW = "2026-08-15T12:00:00.000Z";

describe("worker broker routes", () => {
  let fixture: ProjectFixture | undefined;
  let ui: UiServer | undefined;

  afterEach(async () => {
    await ui?.close();
    ui = undefined;
    await fixture?.cleanup();
    fixture = undefined;
  });

  async function setup() {
    fixture = await createProjectFixture();
    const stateRoot = resolveHarnessPaths(fixture.config).stateRoot;
    const store = new RunStore(fixture.config, stateRoot);
    await store.initialize();
    await store.create(createRunState("run-a", "Idea", NOW));
    await store.writeJson("run-a", "config.json", fixture.config);
    ui = await startUiServer({
      config: fixture.config,
      backend: createFakeBackend({}),
      port: 0,
      token: "broker-test",
      dashboard: false,
    });
    return ui.issueWorkerStateCredential("run-a", { workerInstanceId: "worker-1" });
  }

  async function api(operation: string, token: string, method = "GET") {
    return fetch(`${ui!.origin}${runStateApiPath("run-a", operation)}`, {
      method,
      headers: {
        [RUN_STATE_API_AUTH_HEADER]: token,
        [RUN_STATE_API_PROTOCOL_HEADER]: String(RUN_STATE_API_PROTOCOL_VERSION),
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      body: method === "POST" ? "{}" : undefined,
    });
  }

  it("does not expose durable state operations and allows only the model broker", async () => {
    const { token } = await setup();
    for (const operation of ["snapshot", "compare-and-swap", "bootstrap", "lease/acquire"]) {
      const response = await api(operation, token, operation === "snapshot" || operation === "bootstrap" ? "GET" : "POST");
      expect(response.status, operation).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_found");
    }

    const provider = await api("provider/cursor/bootstrap", token, "POST");
    expect([200, 503]).toContain(provider.status);
  });
});

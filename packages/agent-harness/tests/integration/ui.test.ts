import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

describe("Cordis host lifecycle HTTP adapter", () => {
  let ui: UiServer | undefined;

  afterEach(async () => {
    await ui?.close();
    ui = undefined;
  });

  it("creates host state and enqueues lifecycle work without synchronous Docker ownership", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      git: { enabled: false },
      knowledge: { repositoryIntelligence: { enabled: false } },
    });
    ui = await startUiServer({
      config,
      backend: createFakeBackend({}),
      port: 0,
      token: "ui-test",
    });

    const response = await request(ui, "/api/runs", {
      method: "POST",
      body: { idea: "Create through the host lifecycle", runId: "host-owned-run" },
    });

    expect(response.status).toBe(202);
    await expect(ui.runLifecycle.productState("host-owned-run")).resolves.toMatchObject({
      runId: "host-owned-run",
      phase: "new",
    });
  });

  it("persists the Cordis lifecycle coordinate outside product state", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      git: { enabled: false },
      knowledge: { repositoryIntelligence: { enabled: false } },
    });
    ui = await startUiServer({
      config,
      backend: createFakeBackend({}),
      port: 0,
      token: "ui-test",
    });

    const created = await ui.runLifecycle.createRun(
      config,
      "Persist lifecycle state",
      "lifecycle-coordinate",
    );
    expect(created.phase).toBe("new");

    const artifact = JSON.parse(
      await readFile(
        path.join(
          resolveHarnessPaths(config).stateRoot,
          "runs",
          "lifecycle-coordinate",
          "host-lifecycle.json",
        ),
        "utf8",
      ),
    ) as { stage: string; revision: number };
    expect(artifact).toEqual(expect.objectContaining({ stage: "created", revision: 0 }));
  });
});

async function request(
  ui: UiServer,
  route: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${ui.origin}${route}`, {
    method: options.method ?? "GET",
    headers: {
      "X-Harness-Token": ui.token,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

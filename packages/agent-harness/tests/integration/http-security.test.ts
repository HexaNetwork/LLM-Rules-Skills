import { afterEach, describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/agent.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { withDiagnosticArtifacts } from "../testkit/diagnostics.js";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";
import { waitUntil } from "../testkit/wait.js";

describe("Phase 5 HTTP security", () => {
  let fixture: ProjectFixture | undefined;
  let ui: UiServer | undefined;

  afterEach(async () => {
    await ui?.close();
    ui = undefined;
    await fixture?.cleanup();
    fixture = undefined;
  });

  it("rejects missing tokens, malformed/oversized bodies, traversal, and surfaces failed jobs", async () => {
    fixture = await createProjectFixture({
      config: {
        agent: { promptBuilder: false, schemaRepairAttempts: 0, timeoutMs: 2_000, provider: "cursor" },
        workflow: { tdd: false, maxStepsPerRun: 10 },
        knowledge: { graphify: { enabled: false }, guidance: { enabled: false } },
      },
    });

    await withDiagnosticArtifacts(
      { testName: "http-security-surface", fixture },
      async (diagnostics) => {
        const backend = createFakeBackend({
          reflector: () => ({
            summary: "Restated",
            restatement: "A small feature.",
            goal: "Ship it",
            users: ["users"],
            inScope: ["scope"],
            outOfScope: [],
            assumptions: [],
            unknowns: [],
          }),
        });
        ui = await startUiServer({
          config: fixture!.config,
          backend,
          port: 0,
          token: "phase5-token",
          openBrowser: false,
        });

        const unauth = await fetch(`${ui.origin}/api/bootstrap`);
        expect(unauth.status).toBe(401);
        diagnostics.noteServerError(`bootstrap unauth=${unauth.status}`);

        const malformed = await fetch(`${ui.origin}/api/runs`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Harness-Token": ui.token,
          },
          body: "[1,2,3]",
        });
        expect(malformed.status).toBe(400);
        expect(await malformed.text()).toMatch(/object/i);

        const oversized = await fetch(`${ui.origin}/api/runs`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Harness-Token": ui.token,
          },
          body: JSON.stringify({ idea: "x".repeat(1_100_000) }),
        });
        expect(oversized.status).toBe(413);

        const created = await fetch(`${ui.origin}/api/runs`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Harness-Token": ui.token,
          },
          body: JSON.stringify({ idea: "Trigger a failed job", tdd: false }),
        });
        expect(created.status).toBe(202);
        const runId = ((await created.json()) as { run: { runId: string } }).run.runId;

        await waitUntil(
          async () => {
            const detail = await fetch(`${ui!.origin}/api/runs/${runId}`, {
              headers: { "X-Harness-Token": ui!.token },
            });
            const body = (await detail.json()) as { state?: { phase?: string }; job?: { status?: string } };
            return body.state?.phase === "awaiting_input" && !body.job;
          },
          { timeoutMs: 10_000, message: "expected run to reach awaiting_input" },
        );

        // propose_fix throws when the run is not blocked — that rejection is
        // surfaced as a failed job for the dashboard toast path.
        const propose = await fetch(`${ui.origin}/api/runs/${runId}/actions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Harness-Token": ui.token,
          },
          body: JSON.stringify({ action: "propose_fix", guidance: "try something" }),
        });
        expect(propose.status).toBe(202);

        let failedJob: { status: string; error?: string } | undefined;
        await waitUntil(
          async () => {
            const detail = await fetch(`${ui!.origin}/api/runs/${runId}`, {
              headers: { "X-Harness-Token": ui!.token },
            });
            const body = (await detail.json()) as {
              job?: { status: string; error?: string };
            };
            if (body.job?.status === "failed") {
              failedJob = body.job;
              return true;
            }
            return false;
          },
          { timeoutMs: 10_000, message: "expected failed job to become visible" },
        );
        expect(failedJob?.error).toMatch(/not blocked/i);

        const traversal = await fetch(
          `${ui.origin}/api/runs/${runId}/artifact?path=${encodeURIComponent("../README.md")}`,
          { headers: { "X-Harness-Token": ui.token } },
        );
        expect(traversal.status).toBe(400);

        const folderEscape = await fetch(
          `${ui.origin}/api/repository/folders?path=${encodeURIComponent("..")}`,
          { headers: { "X-Harness-Token": ui.token } },
        );
        expect(folderEscape.status).toBe(400);

        // Mutation surface: unsupported action is rejected without queueing.
        const badAction = await fetch(`${ui.origin}/api/runs/${runId}/actions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Harness-Token": ui.token,
          },
          body: JSON.stringify({ action: "not_a_real_action" }),
        });
        expect(badAction.status).toBe(400);
      },
    );
  });
});

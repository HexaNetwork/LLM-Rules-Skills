import { expect, test } from "@playwright/test";
import { createScriptedBackend } from "../testkit/scripted-backend.js";
import {
  REFLECT_OUTPUT,
  apiJson,
  selectedRunId,
  startNewRun,
  waitForRunStatus,
  withE2EHarness,
} from "./helpers.js";

test("cancellation: cancel while reflector is active ends cancelled with no job", async ({
  page,
}) => {
  let release!: () => void;
  let reflecting!: () => void;
  const startedReflect = new Promise<void>((resolve) => {
    reflecting = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });

  const scripted = createScriptedBackend([
    {
      role: "reflector",
      waitFor: hold,
      output: REFLECT_OUTPUT,
    },
  ]);

  // Notify when the deferred step is entered (queue shift happens before waitFor).
  const originalRun = scripted.backend.run.bind(scripted.backend);
  scripted.backend.run = async (request) => {
    if (request.role === "reflector") reflecting();
    return originalRun(request);
  };

  await withE2EHarness(
    page,
    {
      testName: "e2e-cancellation",
      backend: scripted.backend,
      steps: [],
      config: {
        agent: { timeoutMs: 30_000, promptBuilder: false, schemaRepairAttempts: 0 },
      },
    },
    async ({ page, fixture, ui }) => {
      await startNewRun(page, "Cancel while reflecting");
      await startedReflect;
      await expect(page.getByTestId("cancel-run")).toBeVisible({ timeout: 10_000 });
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByTestId("cancel-run").click();

      release();

      await waitForRunStatus(page, /cancelled/i);

      const runId = await selectedRunId(page);
      await expect
        .poll(async () => {
          const detail = await apiJson<{
            state: { phase: string };
            job?: { status: string } | null;
          }>(ui, `/api/runs/${runId}`);
          return { phase: detail.state.phase, job: detail.job ?? null };
        })
        .toEqual({ phase: "cancelled", job: null });

      const events = await fixture.read(`.agent-harness/runs/${runId}/events.jsonl`);
      expect(events).toMatch(/cancel/i);
    },
  );
});

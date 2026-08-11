import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  FIRST_GRILL_QUESTION,
  REFLECT_OUTPUT,
  apiJson,
  confirmReflectBrief,
  selectedRunId,
  startNewRun,
  waitForRunStatus,
  withE2EHarness,
} from "./helpers.js";

test("polling/scroll safety: user scroll during thinking survives activity-driven polls", async ({
  page,
}) => {
  let releaseGriller!: () => void;
  const grillerGate = new Promise<void>((resolve) => {
    releaseGriller = resolve;
  });

  await withE2EHarness(
    page,
    {
      testName: "e2e-polling-scroll",
      steps: [
        { role: "reflector", output: REFLECT_OUTPUT },
        {
          role: "griller",
          waitFor: grillerGate,
          output: {
            status: "needs_input",
            summary: "Need tone",
            questions: [FIRST_GRILL_QUESTION],
          },
        },
      ],
    },
    async ({ page, fixture, ui }) => {
      await startNewRun(page, "Keep scroll position while the agent thinks");
      await waitForRunStatus(page, /awaiting input|reflect/i);
      await confirmReflectBrief(page, "Confirmed: keep viewport while thinking.");

      await expect(page.locator(".thinking-strip")).toBeVisible({ timeout: 20_000 });

      // Make the page tall enough to scroll, then move away from the thinking strip.
      await page.evaluate(() => {
        const spacer = document.createElement("div");
        spacer.id = "scrollProbeSpacer";
        spacer.style.height = "2400px";
        document.body.appendChild(spacer);
        window.scrollTo(0, 900);
      });
      await expect
        .poll(async () => page.evaluate(() => Math.round(window.scrollY)))
        .toBeGreaterThanOrEqual(800);

      const runId = await selectedRunId(page);
      const before = await apiJson<{ signature: string }>(ui, `/api/runs/${runId}`);
      const activityDir = path.join(fixture.root, ".agent-harness", "runs", runId);
      await mkdir(activityDir, { recursive: true });

      // Activity updates invalidate the run signature and force silent re-renders
      // while pinScrollTop is still held for the in-flight answer job.
      for (let step = 1; step <= 3; step += 1) {
        await writeFile(
          path.join(activityDir, "activity.json"),
          `${JSON.stringify({
            sessionId: "e2e-poll-scroll",
            role: "griller",
            model: "small-model",
            startedAt: new Date().toISOString(),
            lastStepAt: new Date().toISOString(),
            lastStepSummary: `thinking step ${step}`,
            stepCount: step,
          })}\n`,
          "utf8",
        );
        await expect
          .poll(async () => {
            const after = await apiJson<{ signature: string }>(ui, `/api/runs/${runId}`);
            return after.signature;
          })
          .not.toBe(before.signature);

        // Give the dashboard at least one poll interval to capture/restore.
        await expect
          .poll(
            async () => {
              const text = await page.locator(".thinking-strip").innerText();
              return text.includes(`thinking step ${step}`);
            },
            { timeout: 8_000 },
          )
          .toBe(true);

        const scrollY = await page.evaluate(() => Math.round(window.scrollY));
        expect(scrollY, `scroll jumped to top after activity step ${step}`).toBeGreaterThanOrEqual(
          800,
        );
      }

      releaseGriller();
      await waitForRunStatus(page, /awaiting input|grill/i);
    },
  );
});

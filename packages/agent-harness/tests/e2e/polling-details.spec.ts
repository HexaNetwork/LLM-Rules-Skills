import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  apiJson,
  selectedRunId,
  startNewRun,
  waitForRunStatus,
  withE2EHarness} from "./helpers.js";

test("polling/details safety: open Raw failure detail survives signature changes", async ({
  page}) => {
  await withE2EHarness(
    page,
    {
      testName: "e2e-polling-details",
      config: {
        workflow: { maxProviderRetries: 0 }},
      steps: [
        {
          role: "reflector",
          error: new Error("Synthetic provider failure for polling details e2e")}]},
    async ({ page, fixture, ui }) => {
      await startNewRun(page, "Keep Raw failure detail open across polls");
      await waitForRunStatus(page, /blocked/i);

      const details = page.locator("details").filter({
        has: page.locator("summary", { hasText: "Raw failure detail" })});
      await expect(details).toBeVisible({ timeout: 20_000 });
      await details.locator("summary").click();
      await expect(details).toHaveAttribute("open", "");
      // Tag the live node so we can detect a silent poll rewrite that replaces it.
      await details.evaluate((node) => {
        node.dataset.probe = "alive";
      });

      const runId = await selectedRunId(page);
      const before = await apiJson<{ signature: string }>(ui, `/api/runs/${runId}`);

      const activityDir = path.join(fixture.root, ".agent-harness", "runs", runId);
      await mkdir(activityDir, { recursive: true });
      await writeFile(
        path.join(activityDir, "activity.json"),
        `${JSON.stringify({
          sessionId: "e2e-poll-details",
          role: "reflector",
          model: "small-model",
          startedAt: new Date().toISOString(),
          lastStepAt: new Date().toISOString(),
          lastStepSummary: "forcing a signature change while details stay open",
          stepCount: 3})}\n`,
        "utf8",
      );

      await expect
        .poll(async () => {
          const after = await apiJson<{ signature: string }>(ui, `/api/runs/${runId}`);
          return after.signature;
        })
        .not.toBe(before.signature);

      // Pass only after a silent rewrite replaced the node AND left it open.
      await expect
        .poll(
          async () => {
            const probe = await details.getAttribute("data-probe");
            const open = await details.evaluate((node: HTMLDetailsElement) => node.open);
            return { probe, open };
          },
          { timeout: 8_000 },
        )
        .toEqual({ probe: null, open: true });
    },
  );
});

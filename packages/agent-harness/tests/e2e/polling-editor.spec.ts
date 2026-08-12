import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  REFLECT_OUTPUT,
  apiJson,
  selectedRunId,
  startNewRun,
  waitForRunStatus,
  withE2EHarness} from "./helpers.js";

test("polling/editor safety: focused reflect draft survives signature changes", async ({
  page}) => {
  await withE2EHarness(
    page,
    {
      testName: "e2e-polling-editor",
      steps: [{ role: "reflector", output: REFLECT_OUTPUT }]},
    async ({ page, fixture, ui }) => {
      await startNewRun(page, "Protect the reflect editor across polls");
      await waitForRunStatus(page, /awaiting input|reflect/i);

      const restatement = page.locator("#reflectRestatement");
      await expect(restatement).toBeVisible({ timeout: 20_000 });
      const typed = "Operator draft that must survive silent polls.";
      await restatement.click();
      await restatement.fill(typed);
      await restatement.evaluate((node: HTMLTextAreaElement) => {
        node.focus();
        node.setSelectionRange(10, 22);
      });

      const runId = await selectedRunId(page);
      const before = await apiJson<{ signature: string }>(ui, `/api/runs/${runId}`);

      const activityDir = path.join(fixture.root, ".agent-harness", "runs", runId);
      await mkdir(activityDir, { recursive: true });
      await writeFile(
        path.join(activityDir, "activity.json"),
        `${JSON.stringify({
          sessionId: "e2e-poll",
          role: "reflector",
          model: "small-model",
          startedAt: new Date().toISOString(),
          lastStepAt: new Date().toISOString(),
          lastStepSummary: "forcing a signature change",
          stepCount: 7})}\n`,
        "utf8",
      );

      await expect
        .poll(async () => {
          const after = await apiJson<{ signature: string }>(ui, `/api/runs/${runId}`);
          return after.signature;
        })
        .not.toBe(before.signature);

      // Give the dashboard at least one poll interval opportunity, gated on
      // DOM assertions rather than a bare timeout success condition.
      await expect
        .poll(async () => {
          const value = await restatement.inputValue();
          const active = await restatement.evaluate(
            (node) => document.activeElement === node,
          );
          const selection = await restatement.evaluate((node: HTMLTextAreaElement) => ({
            start: node.selectionStart,
            end: node.selectionEnd}));
          return { value, active, selection };
        })
        .toEqual({
          value: typed,
          active: true,
          selection: { start: 10, end: 22 }});

      await expect(page.getByTestId("reflect-form")).toBeVisible();
    },
  );
});

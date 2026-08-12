import { expect, test } from "@playwright/test";
import {
  answerCasualGrill,
  approveHighLevelPlan,
  confirmReflectBrief,
  confirmVerificationSettings,
  continueToPlanning,
  selectedRunId,
  startNewRun,
  waitForRunStatus,
  withE2EHarness} from "./helpers.js";

test("happy path: reflect → grill → plan → complete with artifacts", async ({ page }) => {
  await withE2EHarness(
    page,
    { testName: "e2e-happy-path" },
    async ({ page, fixture, scripted }) => {
      await startNewRun(page, "Add a greeting feature");
      await waitForRunStatus(page, /awaiting input|reflect/i);
      await confirmReflectBrief(page, "Confirmed: casual greeting for the dashboard.");
      await answerCasualGrill(page);
      await continueToPlanning(page);
      await confirmVerificationSettings(page);
      await approveHighLevelPlan(page);
      await waitForRunStatus(page, /completed/i);

      const runId = await selectedRunId(page);
      await page.getByRole("button", { name: /^tasks$/i }).click();
      await expect(page.locator(".item-title", { hasText: /Ship greeting/i })).toBeVisible();
      await expect(page.locator(".badge.completed", { hasText: /done/i }).first()).toBeVisible();

      await page.getByRole("button", { name: /^artifacts$/i }).click();
      await page.locator('button.artifact[data-artifact="brief.md"]').click();
      await expect(page.locator("#artifactContent")).toContainText("Confirmed: casual greeting");

      const brief = await fixture.read(`.agent-harness/runs/${runId}/brief.md`);
      expect(brief).toContain("Confirmed: casual greeting");
      scripted.assertExhausted();
    },
  );
});

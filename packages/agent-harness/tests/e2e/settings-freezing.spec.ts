import { expect, test } from "@playwright/test";
import {
  REFLECT_OUTPUT,
  readFrozenConfig,
  selectedRunId,
  startNewRun,
  waitForRunStatus,
  withE2EHarness,
} from "./helpers.js";

test("settings freezing: test-path edits apply to new runs only on disk snapshots", async ({
  page,
}) => {
  const originalPatterns = ["tests/**", "test/**"];
  const updatedPatterns = ["e2e/**/*.spec.ts", "modules/**/test/**"];

  await withE2EHarness(
    page,
    {
      testName: "e2e-settings-freezing",
      persistConfig: true,
      config: {
        workflow: {
          testPathPatterns: originalPatterns,
        },
      },
      steps: [
        { role: "reflector", output: REFLECT_OUTPUT },
        { role: "reflector", output: REFLECT_OUTPUT },
      ],
    },
    async ({ page, fixture }) => {
      await startNewRun(page, "First run before settings change");
      await waitForRunStatus(page, /awaiting input|reflect/i);
      const firstRunId = await selectedRunId(page);
      const firstFrozen = await readFrozenConfig(fixture, firstRunId);
      expect(firstFrozen.workflow.testPathPatterns).toEqual(originalPatterns);

      await page.getByRole("button", { name: /project settings/i }).click();
      const settingsDialog = page.locator("#settingsDialog");
      await expect(settingsDialog).toBeVisible();
      const patterns = page.locator('[data-setting-key="workflow.testPathPatterns"]');
      await expect(patterns).toBeVisible();
      await patterns.fill(updatedPatterns.join("\n"));
      await expect(patterns).toHaveValue(updatedPatterns.join("\n"));
      await page.locator("#saveSettingsBtn").click();
      await expect(settingsDialog).toBeHidden({ timeout: 10_000 });

      const beforeCount = await page.locator("#runList button.run-item[data-run]").count();
      await startNewRun(page, "Second run after settings change");
      await expect
        .poll(async () => page.locator("#runList button.run-item[data-run]").count())
        .toBe(beforeCount + 1);
      await expect
        .poll(async () => selectedRunId(page))
        .not.toBe(firstRunId);
      const secondRunId = await selectedRunId(page);
      await waitForRunStatus(page, /awaiting input|reflect/i);

      const secondFrozen = await readFrozenConfig(fixture, secondRunId);
      expect(secondFrozen.workflow.testPathPatterns).toEqual(updatedPatterns);

      const firstStill = await readFrozenConfig(fixture, firstRunId);
      expect(firstStill.workflow.testPathPatterns).toEqual(originalPatterns);
    },
  );
});

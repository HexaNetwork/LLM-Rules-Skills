import { expect, test } from "@playwright/test";
import {
  REFLECT_OUTPUT,
  selectedRunId,
  startNewRun,
  waitForRunStatus,
  withE2EHarness,
} from "./helpers.js";

test("recovery: dirty git start → commit preflight via UI → workflow continues", async ({
  page,
}) => {
  await withE2EHarness(
    page,
    {
      testName: "e2e-recovery-preflight",
      initGit: true,
      dirtyFile: { relativePath: "surprise.txt", contents: "dirty tree\n" },
      config: {
        git: {
          enabled: true,
          autoCommitPreflight: false,
          preflightCommitOrder: "branch-then-commit",
        },
      },
      steps: [{ role: "reflector", output: REFLECT_OUTPUT }],
    },
    async ({ page, fixture }) => {
      await startNewRun(page, "Recover from a dirty working tree");
      await waitForRunStatus(page, /blocked/i);
      await expect(page.getByText(/dirty|working tree|uncommitted/i).first()).toBeVisible();

      await page
        .getByRole("button", { name: /branch then commit and retry/i })
        .click();

      await waitForRunStatus(page, /awaiting input|reflect/i);
      await expect(page.getByTestId("reflect-form")).toBeVisible();

      const runId = await selectedRunId(page);
      const events = await fixture.read(`.agent-harness/runs/${runId}/events.jsonl`);
      expect(events).toMatch(/preflight_committed|run\.preflight/i);
      expect(await fixture.git("log", "-1", "--format=%s")).toMatch(/harness|working tree/i);
      expect(await fixture.git("status", "--porcelain")).not.toContain("surprise.txt");
    },
  );
});

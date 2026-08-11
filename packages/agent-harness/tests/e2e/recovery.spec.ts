import { expect, test } from "@playwright/test";
import {
  REFLECT_OUTPUT,
  selectedRunId,
  startNewRun,
  waitForRunStatus,
  withE2EHarness,
} from "./helpers.js";

test("recovery: dirty control checkout starts without notice; worktree preflight orders are hidden", async ({
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
      // Worktree runs do not block on a dirty control checkout and do not surface a notice.
      await waitForRunStatus(page, /awaiting input|reflect|new|running|queued/i);
      await expect(page.getByText(/Control checkout is dirty/i)).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /branch then commit and retry/i }),
      ).toHaveCount(0);

      const runId = await selectedRunId(page);
      const events = await fixture.read(`.agent-harness/runs/${runId}/events.jsonl`);
      expect(events).not.toMatch(/run\.control_checkout_notice/);
      expect(events).not.toMatch(/run\.preflight_committed/);
      // Control dirt remains; it was not imported into the worktree.
      expect(await fixture.git("status", "--porcelain")).toContain("surprise.txt");
    },
  );
});

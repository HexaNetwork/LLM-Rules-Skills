import type { Phase, PhaseResult, Run } from "../domain/types.js";

export function createVerificationSettingsPhase(): Phase {
  return {
    id: "verification-settings",
    async advance(run: Run): Promise<PhaseResult> {
      return {
        kind: "await",
        gate: {
          id: "verification-settings",
          title: "Confirm live verification settings",
          questions: [
            {
              id: "command",
              prompt: `Verification command (blank keeps ${run.settings.verification.command ?? "none"})`,
              kind: "text",
              recommended: run.settings.verification.command ?? "",
            },
            {
              id: "confirm",
              prompt: "Use the current live verification settings?",
              kind: "confirm",
              recommended: "yes",
            },
          ],
        },
      };
    },
    async onAnswer(run, batch): Promise<PhaseResult> {
      const confirm = (batch.answers.confirm ?? "yes").toLowerCase();
      if (confirm !== "yes" && confirm !== "y") {
        return { kind: "block", reason: "Verification settings were rejected", retriable: true };
      }
      run.state.artifacts.verification = {
        command: batch.answers.command || run.settings.verification.command,
        testGlobs: run.settings.verification.testGlobs,
      };
      return { kind: "continue" };
    },
  };
}

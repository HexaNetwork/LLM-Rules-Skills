import { describe, expect, it } from "vitest";
import { HarnessEngine } from "../../src/application/harness-engine.js";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

describe("run analysis prompt generation", () => {
  it("launches the dedicated agent and persists a portable prompt artifact", async () => {
    const root = await fixtureRoot();
    let submittedPrompt = "";
    const backend = createFakeBackend({
      "run-analysis-prompt-writer": (request) => {
        submittedPrompt = request.prompt;
        return {
          summary: "Packaged the run evidence",
          prompt: "Analyze run analysis-run and recommend evidence-backed improvements.",
        };
      },
    });
    const engine = new HarnessEngine(fixtureConfig(root), { backend });
    await engine.start("Exercise the manual analysis trigger", "analysis-run", false, false);

    await engine.generateRunAnalysisPrompt("analysis-run");

    expect(submittedPrompt).toContain("Exercise the manual analysis trigger");
    expect(submittedPrompt).toContain("run.created");
    expect(await engine.store.readText("analysis-run", "run-analysis-prompt.md")).toBe(
      "Analyze run analysis-run and recommend evidence-backed improvements.\n",
    );
    const events = await engine.store.readText("analysis-run", "events.jsonl");
    expect(events).toContain("run.analysis_prompt_generated");
    const sessionFiles = await engine.store.listFiles("analysis-run", "sessions");
    const sessions = await Promise.all(
      sessionFiles
        .filter((file) => file.endsWith(".json"))
        .map((file) => engine.store.readJson("analysis-run", file)),
    );
    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "run-analysis-prompt-writer",
          status: "completed",
          trigger: expect.objectContaining({ classification: "manual" }),
        }),
      ]),
    );
  });
});

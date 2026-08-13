import {
  RunAnalysisPromptOutputSchema,
  type RunAnalysisPromptOutput,
} from "../domain.js";
import type { ApplicationContext } from "./application-context.js";

export const RUN_ANALYSIS_PROMPT_ARTIFACT = "run-analysis-prompt.md";

/** Creates a portable prompt from durable evidence without changing run execution. */
export class RunAnalysisService {
  constructor(private readonly ctx: ApplicationContext) {}

  async generatePrompt(runId: string): Promise<RunAnalysisPromptOutput> {
    return this.ctx.store.withLock(runId, () => this.generatePromptUnlocked(runId));
  }

  private async generatePromptUnlocked(runId: string): Promise<RunAnalysisPromptOutput> {
    const state = await this.ctx.store.load(runId);
    const [events, sessionFiles] = await Promise.all([
      this.readJsonLines(runId, "events.jsonl"),
      this.ctx.store.listFiles(runId, "sessions"),
    ]);
    const sessions = await Promise.all(
      sessionFiles
        .filter((file) => file.endsWith(".json"))
        .map((file) => this.ctx.store.readJson(runId, file)),
    );

    const result = await this.ctx.agents.invoke({
      runId,
      role: "run-analysis-prompt-writer",
      objective:
        "Create a portable prompt that another agent can use to analyze this harness run and recommend improvements.",
      input: {
        evidenceNotice:
          "This packet is bounded by the harness input-character budget. Any clipped string is evidence truncation, not the original run output.",
        runState: state,
        events,
        sessions,
      },
      expectedOutput: "{summary:string,prompt:string}",
      schema: RunAnalysisPromptOutputSchema,
      constraints: [
        "Generate the analysis request; do not perform the requested analysis.",
        "Make the prompt useful when pasted into a fresh agent conversation with no access to this harness.",
        "Include the supplied evidence directly in the generated prompt, organized for efficient review.",
      ],
      retrieval: false,
      buildPrompt: false,
      allowTools: false,
      causal: {
        phase: state.phase,
        invocationKind: "initial",
        trigger: {
          event: "run.analysis_prompt_requested",
          classification: "manual",
          summary: "operator requested a portable run-analysis prompt",
        },
      },
    });

    await this.ctx.store.writeText(
      runId,
      RUN_ANALYSIS_PROMPT_ARTIFACT,
      `${result.prompt.trim()}\n`,
    );
    const latest = await this.ctx.store.load(runId);
    await this.ctx.store.record(latest, "run.analysis_prompt_generated", {
      artifact: RUN_ANALYSIS_PROMPT_ARTIFACT,
      summary: result.summary,
    });
    return result;
  }

  private async readJsonLines(runId: string, relativePath: string): Promise<unknown[]> {
    try {
      const text = await this.ctx.store.readText(runId, relativePath);
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

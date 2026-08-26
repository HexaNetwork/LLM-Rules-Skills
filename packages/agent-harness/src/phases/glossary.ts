import type { Context } from "@deepseek-ai/cordis";
import { loadGlossaryContext } from "../domain/docs-writer.js";
import type { Phase, PhaseResult, Run } from "../domain/types.js";

export function createGlossaryPhase(_ctx: Context): Phase {
  return {
    id: "glossary",
    async advance(run: Run): Promise<PhaseResult> {
      run.state.artifacts.glossaryContext = await loadGlossaryContext(
        run.identity.worktreePath,
        run.state.artifacts.reflectBrief,
      );
      return { kind: "continue" };
    },
  };
}

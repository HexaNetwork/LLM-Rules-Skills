import type { Context } from "@deepseek-ai/cordis";
import {
  normalizeDocsWriterOutput,
  writeDocsWriterArtifacts,
} from "../domain/docs-writer.js";
import { buildDocsWriterInput } from "../domain/role-packets.js";
import type { FogResolution, Phase, PhaseResult, Run } from "../domain/types.js";
import { invokeRole } from "./helpers.js";

export function createPrdPhase(ctx: Context): Phase {
  return {
    id: "prd",
    async advance(run: Run): Promise<PhaseResult> {
      const output = normalizeDocsWriterOutput(
        await invokeRole(
          ctx,
          run,
          "docs-writer",
          buildDocsWriterInput({
            brief: run.state.artifacts.reflectBrief,
            resolutions: run.state.artifacts.resolutions,
            fogResolutions: run.state.artifacts.fogResolutions as FogResolution[] | undefined,
            plan: run.state.artifacts.plan,
            existingGlossary: Array.isArray(run.state.artifacts.glossaryContext)
              ? run.state.artifacts.glossaryContext
              : undefined,
            planningFeedback: run.state.artifacts.planningFeedback,
            operatorNotes: run.state.artifacts.operatorNotes,
          }),
        ),
      );
      run.state.artifacts.glossary = output.glossary;
      run.state.artifacts.prd = { title: output.title, body: output.body };
      const paths = await writeDocsWriterArtifacts(run.identity.worktreePath, output);
      run.state.artifacts.docsWriterPaths = paths;
      return { kind: "continue" };
    },
  };
}

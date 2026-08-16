import type { Context } from "@deepseek-ai/cordis";
import type { Phase, PhaseResult, Run } from "../domain/types.js";
import { asRecord, invokeRole } from "./helpers.js";

export function createPublishPhase(ctx: Context): Phase {
  return {
    id: "publish",
    async advance(run: Run): Promise<PhaseResult> {
      const copy = asRecord(
        await invokeRole(ctx, run, "message-writer", {
          idea: run.state.idea,
          plan: run.state.artifacts.plan,
        }),
      );
      const title = String(copy.title ?? run.state.idea).slice(0, 72);
      const body = String(copy.body ?? run.state.idea);
      const published = await ctx.git.publish(run.identity, title, body);
      run.state.artifacts.publish = published;
      return { kind: "done" };
    },
  };
}

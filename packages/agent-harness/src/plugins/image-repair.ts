import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
  mainDockerfilePath,
  readMainDockerfile,
  readRunDockerfile,
  runDockerfilePath,
  runImageTag,
  validateRepairedDockerfile,
  writeRunDockerfile,
} from "../domain/image-repair.js";
import type { Run, VerificationEvidence } from "../domain/types.js";
import { asRecord, invokeRole } from "../phases/helpers.js";
import { verificationCommand } from "../phases/verification.js";

export type ImageRepairProposal = {
  summary: string;
  dockerfile: string;
  image: string;
  at: string;
  appliedToMainAt?: string;
};

export type ImageRepairStatus = {
  mode: "none" | "docker";
  mainImage: string;
  effectiveImage: string;
  hasOverride: boolean;
  attempts: number;
  maxAttempts: number;
  mainDockerfile: string;
  runDockerfile?: string;
  proposal?: ImageRepairProposal;
};

export type ImageRepairAttempt = {
  attempted: boolean;
  repaired: boolean;
  evidence?: VerificationEvidence;
  reason?: string;
};

export type ImageRepairService = {
  status(run: Run): Promise<ImageRepairStatus>;
  repair(
    run: Run,
    options?: { evidence?: VerificationEvidence; force?: boolean },
  ): Promise<ImageRepairAttempt>;
  applyToMain(run: Run): Promise<{ image: string; output: string }>;
  reset(run: Run): Promise<void>;
};

export function createImageRepairService(ctx: Context): ImageRepairService {
  return {
    async status(run) {
      const runDockerfile = await readRunDockerfile(ctx.store.home, run.identity.runId);
      const hasOverride = runDockerfile !== undefined;
      return {
        mode: ctx.sandbox.mode,
        mainImage: ctx.sandbox.image,
        effectiveImage: hasOverride ? runImageTag(run.identity.runId) : ctx.sandbox.image,
        hasOverride,
        attempts: Number(run.state.artifacts.imageRepairAttempts ?? 0),
        maxAttempts: run.settings.workflow.maxImageRepairAttempts,
        mainDockerfile: await readMainDockerfile().catch(() => ""),
        runDockerfile,
        proposal: run.state.artifacts.imageRepair as ImageRepairProposal | undefined,
      };
    },

    async repair(run, options = {}) {
      if (ctx.sandbox.mode !== "docker") {
        return {
          attempted: false,
          repaired: false,
          reason: "Sandbox mode is not docker; there is no worker image to repair.",
        };
      }
      const attempts = Number(run.state.artifacts.imageRepairAttempts ?? 0);
      const maxAttempts = run.settings.workflow.maxImageRepairAttempts;
      if (!options.force && attempts >= maxAttempts) {
        return {
          attempted: false,
          repaired: false,
          reason: `Image repair attempts exhausted (${attempts}/${maxAttempts}).`,
        };
      }
      const command = options.evidence?.command || verificationCommand(run) || "";
      const output = options.evidence?.output ?? "";
      const runId = run.identity.runId;
      const base = (await readRunDockerfile(ctx.store.home, runId)) ?? (await readMainDockerfile());

      run.state.artifacts.imageRepairAttempts = attempts + 1;
      await ctx.store.writeState(run.state);

      let reply: Record<string, unknown>;
      try {
        reply = asRecord(
          await invokeRole(ctx, run, "image-fixer", {
            command,
            output,
            dockerfile: base,
            image: runImageTag(runId),
          }),
        );
      } catch (error) {
        return {
          attempted: true,
          repaired: false,
          reason: `image-fixer invocation failed: ${(error as Error).message}`,
        };
      }

      const dockerfile = String(reply.dockerfile ?? "").trim();
      const invalid = validateRepairedDockerfile(base, dockerfile);
      if (invalid) {
        return { attempted: true, repaired: false, reason: invalid };
      }

      const tag = runImageTag(runId);
      await writeRunDockerfile(ctx.store.home, runId, dockerfile);
      try {
        await ctx.sandbox.buildImage(runDockerfilePath(ctx.store.home, runId), tag);
      } catch (error) {
        return { attempted: true, repaired: false, reason: (error as Error).message };
      }

      run.state.artifacts.imageRepair = {
        summary: String(reply.summary ?? ""),
        dockerfile,
        image: tag,
        at: new Date().toISOString(),
      } satisfies ImageRepairProposal;
      await ctx.store.writeState(run.state);

      await ctx.sandbox.destroy(runId);

      if (!command) return { attempted: true, repaired: true };
      const evidence = await ctx.commands.verify(runId, command);
      return {
        attempted: true,
        repaired: !evidence || evidence.classification !== "environment_failure",
        evidence,
      };
    },

    async applyToMain(run) {
      const runDockerfile = await readRunDockerfile(ctx.store.home, run.identity.runId);
      if (runDockerfile === undefined) {
        throw new Error("No run-scoped image repair to apply.");
      }
      const mainBase = await readMainDockerfile().catch(() => runDockerfile);
      const invalid = validateRepairedDockerfile(mainBase, runDockerfile);
      if (invalid) throw new Error(invalid);
      await writeFile(mainDockerfilePath(), runDockerfile, "utf8");
      const output = await ctx.sandbox.buildImage(mainDockerfilePath(), ctx.sandbox.image);
      const proposal = run.state.artifacts.imageRepair as ImageRepairProposal | undefined;
      if (proposal) {
        proposal.appliedToMainAt = new Date().toISOString();
        await ctx.store.writeState(run.state);
      }
      return { image: ctx.sandbox.image, output };
    },

    async reset(run) {
      await rm(path.join(ctx.store.home, "runs", run.identity.runId, "image"), {
        recursive: true,
        force: true,
      });
      await ctx.sandbox.destroy(run.identity.runId, { purgeImage: true });
    },
  };
}

export const imageRepairPlugin = Object.assign(
  (ctx: Context) => {
    ctx.provide("imageRepair", createImageRepairService(ctx));
  },
  {
    inject: ["store", "sandbox", "agents", "roleGuidance", "packets", "commands", "settings"],
  },
);

import type { Context } from "@deepseek-ai/cordis";
import type { Phase, PhaseResult, Question, QuestionOption, Run } from "../domain/types.js";
import { asRecord, invokeRole } from "./helpers.js";
import { environmentBlock, repairImageForEnvironmentFailure } from "./verification.js";

export type SpecificVerificationCommand = {
  id: string;
  label: string;
  command: string;
  rationale?: string;
};

export type VerificationProposal = {
  command: string;
  testGlobs: string[];
  rationale?: string;
  specificCommands: SpecificVerificationCommand[];
  source: "agent" | "settings" | "none";
};

export function createVerificationSettingsPhase(ctx: Context): Phase {
  return {
    id: "verification-settings",
    async advance(run: Run): Promise<PhaseResult> {
      const proposal = await proposeVerification(ctx, run);
      run.state.artifacts.verificationProposal = proposal;
      return {
        kind: "await",
        gate: {
          id: "verification-settings",
          title: "Confirm verification for this feature",
          questions: buildQuestions(proposal),
        },
      };
    },
    async onAnswer(run, batch): Promise<PhaseResult> {
      const proposal =
        (run.state.artifacts.verificationProposal as VerificationProposal | undefined) ??
        fallbackProposal(run);
      const selection =
        (batch.answers.selection ?? recommendedSelection(proposal)).trim() || "generic";
      const override = (batch.answers.command ?? "").trim();
      const selected = resolveCommand(proposal, selection, override);
      if (!selected) {
        return {
          kind: "block",
          reason: "Pick a verification command, or enter one manually",
          retriable: true,
        };
      }
      run.state.artifacts.verification = {
        command: selected,
        testGlobs: proposal.testGlobs,
        selection,
        proposal,
      };
      const preflight = await ctx.commands.verify(run.identity.runId, selected);
      if (preflight && preflight.classification === "environment_failure") {
        const repaired = await repairImageForEnvironmentFailure(ctx, run, preflight);
        if (repaired.classification === "environment_failure") {
          return { kind: "block", reason: environmentBlock(repaired), retriable: true };
        }
      }
      return { kind: "continue" };
    },
  };
}

async function proposeVerification(ctx: Context, run: Run): Promise<VerificationProposal> {
  const live = run.settings.verification;
  try {
    const output = asRecord(
      await invokeRole(ctx, run, "project-profiler", {
        brief: run.state.artifacts.reflectBrief,
        idea: run.state.idea,
        liveVerification: live,
        fog: run.state.fog,
        resolutions: run.state.artifacts.resolutions,
      }),
    );
    return normalizeProposal(output, live);
  } catch {
    return fallbackProposal(run);
  }
}

export function normalizeProposal(
  raw: Record<string, unknown>,
  live: { command?: string; testGlobs: string[] },
): VerificationProposal {
  const agentCommand = firstString(raw.command) ?? "";
  const command = agentCommand || live.command || "";
  const testGlobs = normalizeStringList(raw.testGlobs);
  const rationale = optionalString(raw.rationale);
  const specificCommands = normalizeSpecificCommands(raw.specificCommands);
  return {
    command,
    testGlobs: testGlobs.length > 0 ? testGlobs : live.testGlobs,
    rationale,
    specificCommands,
    source: agentCommand || specificCommands.length > 0 ? "agent" : live.command ? "settings" : "none",
  };
}

function fallbackProposal(run: Run): VerificationProposal {
  const live = run.settings.verification;
  return {
    command: live.command ?? "",
    testGlobs: live.testGlobs,
    rationale: live.command ? "Using the project's live verification settings." : undefined,
    specificCommands: [],
    source: live.command ? "settings" : "none",
  };
}

function buildQuestions(proposal: VerificationProposal): Question[] {
  const options: QuestionOption[] = [
    {
      id: "generic",
      label: proposal.command ? "Project default" : "No project default",
      description: proposal.command
        ? proposal.command
        : "No generic command found. Enter one below or choose a specific command.",
    },
    ...proposal.specificCommands.map((entry) => ({
      id: entry.id,
      label: entry.label,
      description: entry.rationale ? `${entry.command}\n${entry.rationale}` : entry.command,
    })),
  ];
  const recommended = recommendedSelection(proposal);
  const recommendedCommand = resolveCommand(proposal, recommended, "") ?? proposal.command;
  const contextParts = [
    proposal.rationale,
    proposal.testGlobs.length > 0 ? `Test globs: ${proposal.testGlobs.join(", ")}` : undefined,
    proposal.source === "settings" ? "Fell back to live project settings." : undefined,
    proposal.source === "none"
      ? "No verification command was inferred. Enter one if this run should verify."
      : undefined,
  ].filter(Boolean);

  return [
    {
      id: "selection",
      prompt: "Which verification command should this run use?",
      kind: "choice",
      context: contextParts.join(" "),
      options,
      recommendedOptionId: recommended,
      recommendation:
        recommended === "generic"
          ? "Use the project-wide command unless a specific command clearly covers this feature."
          : "A feature-specific command was proposed; prefer it when it still proves the slice.",
      recommended,
    },
    {
      id: "command",
      prompt: "Command override (optional; blank keeps the selection above)",
      kind: "text",
      recommended: recommendedCommand,
    },
  ];
}

function recommendedSelection(proposal: VerificationProposal): string {
  if (proposal.command) return "generic";
  return proposal.specificCommands[0]?.id ?? "generic";
}

function resolveCommand(
  proposal: VerificationProposal,
  selection: string,
  override: string,
): string | undefined {
  if (override) return override;
  if (selection === "generic") return proposal.command || undefined;
  const specific = proposal.specificCommands.find((entry) => entry.id === selection);
  return specific?.command || proposal.command || undefined;
}

function normalizeSpecificCommands(raw: unknown): SpecificVerificationCommand[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const command = firstString(row.command);
    if (!command) return [];
    const id = (optionalString(row.id) || `specific-${index + 1}`).replace(/\s+/g, "-");
    const label = optionalString(row.label) || command;
    return [
      {
        id,
        label,
        command,
        rationale: optionalString(row.rationale),
      },
    ];
  });
}

function normalizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((item) => String(item ?? "").trim()).filter(Boolean))];
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = optionalString(value);
    if (text) return text;
  }
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

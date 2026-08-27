import type { Context } from "@deepseek-ai/cordis";
import { seedFog } from "../domain/fog.js";
import {
  REFLECT_SECTIONS,
  applyReflectEdits,
  coerceReflectOutput,
  formatReflectRestatement,
  type ReflectOutput,
} from "../domain/reflect.js";
import { buildReflectorInput } from "../domain/role-packets.js";
import type { AnswerBatch, Phase, PhaseResult, Question, Run } from "../domain/types.js";
import { invokeRole } from "./helpers.js";

export function createReflectPhase(ctx: Context): Phase {
  return {
    id: "reflect",
    async enter(run: Run) {
      run.state.artifacts.idea = run.state.idea;
    },
    async advance(run: Run): Promise<PhaseResult> {
      let output: ReflectOutput;
      try {
        output = coerceReflectOutput(
          await invokeRole(
            ctx,
            run,
            "reflector",
            buildReflectorInput({ idea: run.state.idea }),
            { resumeAgent: true },
          ),
        );
      } catch (error) {
        return contractBlock(error);
      }
      run.state.artifacts.reflect = output;
      run.state.fog = seedFog(output.unknowns, run.state.fog);
      return {
        kind: "await",
        gate: {
          id: "reflect-confirm",
          title: "Confirm feature understanding",
          questions: reflectQuestions(output),
        },
      };
    },
    async onAnswer(run: Run, batch: AnswerBatch): Promise<PhaseResult> {
      const hasAnswers = Object.values(batch.answers).some((value) => value?.trim());
      if (!hasAnswers) {
        return { kind: "block", reason: "Reflect confirmation is required", retriable: true };
      }
      let existing: ReflectOutput;
      try {
        existing = coerceReflectOutput(run.state.artifacts.reflect);
      } catch (error) {
        return contractBlock(error);
      }
      const structured = applyReflectEdits(existing, batch.answers);
      const confirmed = formatReflectRestatement(structured);
      run.state.artifacts.reflect = structured;
      run.state.artifacts.reflectBrief = { confirmed, structured, notes: batch.notes };
      run.state.fog = seedFog(structured.unknowns, run.state.fog);
      return { kind: "continue" };
    },
  };
}

function reflectQuestions(output: ReflectOutput): Question[] {
  return REFLECT_SECTIONS.map((section) => ({
    id: section.id,
    prompt: section.label,
    kind: "text" as const,
    recommended: section.list
      ? ((output[section.id] as string[] | undefined) ?? []).join("\n")
      : String(output[section.id] ?? ""),
  }));
}

function contractBlock(error: unknown): PhaseResult {
  const detail = error instanceof Error ? error.message : String(error);
  return { kind: "block", reason: `Invalid reflector output: ${detail}`, retriable: true };
}

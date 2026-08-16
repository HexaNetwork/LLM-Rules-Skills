import type { Context } from "@deepseek-ai/cordis";
import { applyAnswers, markAsked, openFog, reconcileFog } from "../domain/fog.js";
import type { AnswerBatch, Phase, PhaseResult, Question, Run } from "../domain/types.js";
import { asRecord, invokeRole } from "./helpers.js";

export function createGrillPhase(ctx: Context): Phase {
  return {
    id: "grill",
    async advance(run: Run): Promise<PhaseResult> {
      const output = asRecord(
        await invokeRole(ctx, run, "griller", {
          brief: run.state.artifacts.reflectBrief,
          fog: run.state.fog,
          notes: run.state.artifacts.operatorNotes,
          resolutions: run.state.artifacts.resolutions,
        }),
      );
      const unknowns = Array.isArray(output.unknowns) ? output.unknowns.map(String) : [];
      run.state.fog = reconcileFog(unknowns, run.state.fog);
      const questions = normalizeQuestions(output.questions).slice(
        0,
        run.settings.workflow.grillQuestionsPerBatch,
      );
      if (questions.length === 0 && openFog(run.state.fog).length === 0) {
        return { kind: "continue" };
      }
      if (questions.length === 0) {
        return { kind: "continue" };
      }
      run.state.fog = markAsked(
        run.state.fog,
        questions.map((question) => question.prompt),
      );
      run.state.artifacts.grillBatch = questions;
      return {
        kind: "await",
        gate: { id: "grill-batch", title: "Grill questions", questions },
      };
    },
    async onAnswer(run: Run, batch: AnswerBatch): Promise<PhaseResult> {
      const questions = (run.state.artifacts.grillBatch as Question[] | undefined) ?? [];
      const missing = questions.filter((question) => !batch.answers[question.id] && !batch.parked?.includes(question.id));
      if (missing.length > 0) {
        return { kind: "block", reason: "Answer or park every question in the batch", retriable: true };
      }
      const answered = questions
        .filter((question) => batch.answers[question.id])
        .map((question) => question.prompt);
      const parked = questions
        .filter((question) => batch.parked?.includes(question.id))
        .map((question) => question.prompt);
      run.state.fog = applyAnswers(run.state.fog, answered, parked).map((entry) =>
        entry.status === "asked" ? { ...entry, status: "resolved" } : entry,
      );
      run.state.artifacts.resolutions = [
        ...((run.state.artifacts.resolutions as unknown[]) ?? []),
        { answers: batch.answers, parked: batch.parked ?? [], notes: batch.notes },
      ];
      if (batch.notes) run.state.artifacts.operatorNotes = batch.notes;
      return this.advance(run, { reason: "continue" });
    },
  };
}

function normalizeQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const prompt = String(row.prompt ?? row.text ?? "").trim();
    if (!prompt) return [];
    return [
      {
        id: String(row.id ?? `q${index + 1}`),
        prompt,
        kind: row.kind === "choice" || row.kind === "confirm" ? row.kind : "text",
        choices: Array.isArray(row.choices) ? row.choices.map(String) : undefined,
        recommended: row.recommended ? String(row.recommended) : undefined,
      },
    ];
  });
}

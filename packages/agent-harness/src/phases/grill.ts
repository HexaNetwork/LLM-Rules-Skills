import type { Context } from "@deepseek-ai/cordis";
import { applyAnswers, markAsked, openFog, reconcileFog } from "../domain/fog.js";
import type { AnswerBatch, Phase, PhaseResult, Question, QuestionOption, Run } from "../domain/types.js";
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
      const clarifyById = new Map(
        (batch.clarifications ?? [])
          .map((entry) => [entry.questionId, String(entry.text ?? "").trim()] as const)
          .filter((entry) => entry[1]),
      );
      for (const entry of batch.clarifications ?? []) {
        if (!String(entry.text ?? "").trim()) {
          return {
            kind: "block",
            reason: `Clarification for ${entry.questionId} cannot be empty`,
            retriable: true,
          };
        }
      }
      const parkedIds = new Set([...(batch.parked ?? []), ...clarifyById.keys()]);
      const missing = questions.filter(
        (question) => !batch.answers[question.id] && !parkedIds.has(question.id),
      );
      if (missing.length > 0) {
        return { kind: "block", reason: "Answer or park every question in the batch", retriable: true };
      }
      const answered = questions
        .filter((question) => batch.answers[question.id] && !parkedIds.has(question.id))
        .map((question) => question.prompt);
      const parked = questions
        .filter((question) => parkedIds.has(question.id))
        .map((question) => question.prompt);
      run.state.fog = applyAnswers(run.state.fog, answered, parked).map((entry) =>
        entry.status === "asked" ? { ...entry, status: "resolved" } : entry,
      );
      run.state.artifacts.resolutions = [
        ...((run.state.artifacts.resolutions as unknown[]) ?? []),
        {
          answers: batch.answers,
          parked: [...parkedIds],
          notes: batch.notes,
          clarifications: batch.clarifications ?? [],
        },
      ];
      const noteParts: string[] = [];
      const prior = run.state.artifacts.operatorNotes;
      if (typeof prior === "string" && prior.trim()) noteParts.push(prior.trim());
      if (batch.notes?.trim()) noteParts.push(batch.notes.trim());
      for (const [questionId, ask] of clarifyById) {
        const question = questions.find((item) => item.id === questionId);
        const prompt = question?.prompt?.trim() || questionId;
        noteParts.push(`Clarification requested on grill question:\nQ: ${prompt}\nAsk: ${ask}`);
      }
      if (noteParts.length > 0) run.state.artifacts.operatorNotes = noteParts.join("\n\n");
      return this.advance(run, { reason: "continue" });
    },
  };
}

export function normalizeQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const prompt = String(row.prompt ?? row.text ?? "").trim();
    if (!prompt) return [];
    const options = normalizeOptions(row);
    const recommendedOptionId = resolveRecommendedOptionId(row, options);
    const recommendation =
      row.recommendation != null
        ? String(row.recommendation)
        : row.recommended != null && !options?.some((option) => option.id === String(row.recommended))
          ? String(row.recommended)
          : undefined;
    const kind =
      row.kind === "choice" || row.kind === "confirm"
        ? row.kind
        : options && options.length > 0
          ? "choice"
          : "text";
    return [
      {
        id: String(row.id ?? `q${index + 1}`),
        prompt,
        kind,
        context: row.context != null ? String(row.context) : undefined,
        options,
        recommendedOptionId,
        recommendation,
        choices: Array.isArray(row.choices) ? row.choices.map(String) : undefined,
        recommended: row.recommended != null ? String(row.recommended) : undefined,
      },
    ];
  });
}

function normalizeOptions(row: Record<string, unknown>): QuestionOption[] | undefined {
  if (Array.isArray(row.options) && row.options.length > 0) {
    const options = row.options.flatMap((item, index) => {
      if (!item || typeof item !== "object") return [];
      const option = item as Record<string, unknown>;
      const label = String(option.label ?? option.text ?? "").trim();
      if (!label) return [];
      return [
        {
          id: String(option.id ?? `opt-${index + 1}`),
          label,
          description: String(option.description ?? ""),
        },
      ];
    });
    return options.length > 0 ? options : undefined;
  }
  if (Array.isArray(row.choices) && row.choices.length > 0) {
    return row.choices.map((choice, index) => ({
      id: `opt-${index + 1}`,
      label: String(choice),
      description: "",
    }));
  }
  return undefined;
}

function resolveRecommendedOptionId(
  row: Record<string, unknown>,
  options: QuestionOption[] | undefined,
): string | undefined {
  if (!options?.length) return undefined;
  if (row.recommendedOptionId != null) {
    const id = String(row.recommendedOptionId);
    if (options.some((option) => option.id === id)) return id;
  }
  if (row.recommended != null) {
    const recommended = String(row.recommended);
    const byId = options.find((option) => option.id === recommended);
    if (byId) return byId.id;
    const byLabel = options.find((option) => option.label === recommended);
    if (byLabel) return byLabel.id;
  }
  return undefined;
}

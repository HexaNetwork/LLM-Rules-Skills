import type { Context } from "@deepseek-ai/cordis";
import {
  applyCodeResolutions,
  applyAnswers,
  markAsked,
  openFog,
  reconcileFog,
} from "../domain/fog.js";
import { buildGrillerInput } from "../domain/role-packets.js";
import type {
  AnswerBatch,
  FogDraft,
  FogResolution,
  Phase,
  PhaseResult,
  Question,
  QuestionOption,
  Run,
} from "../domain/types.js";
import { asRecord, invokeRole } from "./helpers.js";

export function createGrillPhase(ctx: Context): Phase {
  return {
    id: "grill",
    async advance(run: Run): Promise<PhaseResult> {
      const output = asRecord(
        await invokeRole(
          ctx,
          run,
          "griller",
          buildGrillerInput({
            brief: run.state.artifacts.reflectBrief,
            fog: run.state.fog,
            notes: run.state.artifacts.operatorNotes,
            resolutions: run.state.artifacts.resolutions,
          }),
        ),
      );
      let nextFog;
      let resolutions: FogResolution[];
      try {
        const rawUnknowns = output.newUnknowns ?? output.unknowns;
        nextFog = reconcileFog(normalizeFogDrafts(rawUnknowns), run.state.fog);
        resolutions = normalizeFogResolutions(output.resolvedUnknowns);
      } catch (error) {
        return contractBlock(error);
      }

      const fogById = new Map(nextFog.map((entry) => [entry.id, entry]));
      for (const resolution of resolutions) {
        const entry = fogById.get(resolution.id);
        if (!entry) {
          return contractBlock(`Resolution references unknown fog id ${resolution.id}`);
        }
        if (entry.status === "resolved") {
          return contractBlock(`Fog id ${resolution.id} is already resolved`);
        }
      }
      nextFog = applyCodeResolutions(nextFog, resolutions);
      const questions = normalizeQuestions(output.questions).slice(
        0,
        run.settings.workflow.grillQuestionsPerBatch,
      );
      const questionFogIds = new Set<string>();
      for (const question of questions) {
        if (!question.fogIds?.length) {
          return contractBlock(`Question ${question.id} does not reference any fogIds`);
        }
        for (const fogId of question.fogIds) {
          const entry = nextFog.find((item) => item.id === fogId);
          if (!entry) return contractBlock(`Question ${question.id} references unknown fog id ${fogId}`);
          if (entry.status === "resolved") {
            return contractBlock(`Question ${question.id} references resolved fog id ${fogId}`);
          }
          if (questionFogIds.has(fogId)) {
            return contractBlock(`Fog id ${fogId} is linked to more than one question in the batch`);
          }
          questionFogIds.add(fogId);
        }
      }

      run.state.fog = nextFog;
      if (resolutions.length > 0) {
        const prior = (run.state.artifacts.fogResolutions as FogResolution[] | undefined) ?? [];
        run.state.artifacts.fogResolutions = [...prior, ...resolutions];
      }
      if (questions.length === 0 && openFog(nextFog).length === 0) {
        return { kind: "continue" };
      }
      if (questions.length === 0) {
        return {
          kind: "block",
          reason: `Griller returned no questions while ${openFog(nextFog).length} unknowns remain open`,
          retriable: true,
        };
      }
      run.state.fog = markAsked(
        run.state.fog,
        questions.flatMap((question) => question.fogIds ?? []),
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
        .flatMap((question) =>
          (question.fogIds ?? []).map((id) => ({
            id,
            reason: `Answer to "${question.prompt}": ${batch.answers[question.id]}`,
          })),
        );
      const parked = questions
        .filter((question) => parkedIds.has(question.id))
        .flatMap((question) => question.fogIds ?? []);
      run.state.fog = applyAnswers(run.state.fog, answered, parked);
      if (answered.length > 0) {
        const prior = (run.state.artifacts.fogResolutions as FogResolution[] | undefined) ?? [];
        run.state.artifacts.fogResolutions = [
          ...prior,
          ...answered.map((entry) => ({ ...entry, source: "user" as const })),
        ];
      }
      run.state.artifacts.resolutions = [
        ...((run.state.artifacts.resolutions as unknown[]) ?? []),
        {
          answers: batch.answers,
          parked: [...parkedIds],
          resolvedFogIds: answered.map((entry) => entry.id),
          parkedFogIds: parked,
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
      // Hand control back to the lifecycle so answers + cleared gate are
      // persisted before the next griller invoke. Calling advance here kept the
      // prior gate on disk for the whole agent turn, so a refresh resurfaced
      // the same unanswered questions.
      run.state.gate = undefined;
      delete run.state.artifacts.grillBatch;
      return { kind: "continue", next: "grill" };
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
        fogIds: Array.isArray(row.fogIds)
          ? [...new Set(row.fogIds.map(String).map((id) => id.trim()).filter(Boolean))]
          : undefined,
        choices: Array.isArray(row.choices) ? row.choices.map(String) : undefined,
        recommended: row.recommended != null ? String(row.recommended) : undefined,
      },
    ];
  });
}

export function normalizeFogDrafts(raw: unknown): Array<string | FogDraft> {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error("newUnknowns must be an array");
  return raw.map((item, index) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") {
      throw new Error(`newUnknowns[${index}] must contain id and text`);
    }
    const row = item as Record<string, unknown>;
    const id = String(row.id ?? "").trim();
    const text = String(row.text ?? "").trim();
    if (!id || !text) throw new Error(`newUnknowns[${index}] must contain id and text`);
    return { id, text };
  });
}

export function normalizeFogResolutions(raw: unknown): FogResolution[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error("resolvedUnknowns must be an array");
  return raw.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`resolvedUnknowns[${index}] must contain id, source "code", and reason`);
    }
    const row = item as Record<string, unknown>;
    const id = String(row.id ?? "").trim();
    const source = String(row.source ?? "").trim();
    const reason = String(row.reason ?? "").trim();
    if (!id || source !== "code" || !reason) {
      throw new Error(`resolvedUnknowns[${index}] must contain id, source "code", and reason`);
    }
    return { id, source, reason };
  });
}

function contractBlock(error: unknown): PhaseResult {
  const detail = error instanceof Error ? error.message : String(error);
  return { kind: "block", reason: `Invalid griller output: ${detail}`, retriable: true };
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

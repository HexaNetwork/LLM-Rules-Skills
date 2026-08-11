import { randomUUID } from "node:crypto";
import {
  GRILL_EXPECTED_OUTPUT,
  GrillOutputSchema,
  REFLECT_EXPECTED_OUTPUT,
  ReflectOutputSchema,
  applyGrillOutput,
  applyReflectOutput,
  formatReflectRestatement,
  seedUnknownsFromReflect,
  type GrillEpisode,
  type GrillOutput,
  type HumanQuestionDraft,
  type OpenUnknown,
  type OperatorNote,
  type QuestionPurpose,
  type ReflectOutput,
  type RunState,
} from "../domain.js";
import type { InvokeInput } from "../agent.js";
import { compactDomainSeed } from "../knowledge.js";
import type { ApplicationContext } from "./application-context.js";
import { pendingGrillReady } from "./helpers.js";

export class InterviewService {
  constructor(private readonly ctx: ApplicationContext) {}

  async answer(
    runId: string,
    questionId: string,
    answer: string,
    structured?: ReflectOutput,
  ): Promise<RunState> {
    return this.answerMany(runId, [{ questionId, answer, structured }]);
  }

  /**
   * Answers and/or parks a batch of open questions in one state transition.
   * Clarifications park the question and seed an operator note (asUnknown) for the next grill turn.
   * Staleness is computed once per batch (shared askedAt), not per question.
   */

  async answerMany(
    runId: string,
    answers: Array<{
      questionId: string;
      answer: string;
      optionId?: string;
      structured?: ReflectOutput;
    }> = [],
    parkedQuestionIds: string[] = [],
    clarifications: Array<{ questionId: string; text: string }> = [],
  ): Promise<RunState> {
    if (answers.length === 0 && parkedQuestionIds.length === 0 && clarifications.length === 0) {
      throw new Error("At least one answer, parked question id, or clarification is required");
    }
    for (const entry of answers) {
      if (!entry.answer.trim()) throw new Error(`Answer for ${entry.questionId} cannot be empty`);
    }
    for (const entry of clarifications) {
      if (!entry.text.trim()) {
        throw new Error(`Clarification for ${entry.questionId} cannot be empty`);
      }
    }
    return this.ctx.store.withLock(runId, async () => {
      let state = await this.ctx.store.load(runId);
      const now = new Date().toISOString();
      const byId = new Map(state.questions.map((item) => [item.id, item] as const));
      const clarifyById = new Map(
        clarifications.map((entry) => [entry.questionId, entry.text.trim()] as const),
      );

      for (const entry of answers) {
        const question = byId.get(entry.questionId);
        if (!question || question.status !== "open") {
          throw new Error(`Question ${entry.questionId} is not open`);
        }
      }
      for (const id of parkedQuestionIds) {
        const question = byId.get(id);
        if (!question || question.status !== "open") throw new Error(`Question ${id} is not open`);
      }
      for (const id of clarifyById.keys()) {
        const question = byId.get(id);
        if (!question || question.status !== "open") throw new Error(`Question ${id} is not open`);
      }

      const reflectEntry = answers.find((entry) => byId.get(entry.questionId)?.purpose === "reflect");
      if (reflectEntry) {
        // Reflect always asks a single confirmable question; never batched with grill.
        if (answers.length !== 1 || parkedQuestionIds.length !== 0 || clarifyById.size !== 0) {
          throw new Error("The reflect confirmation must be answered on its own");
        }
        const trimmed = reflectEntry.answer.trim();
        const questions = state.questions.map((item) =>
          item.id === reflectEntry.questionId
            ? { ...item, status: "answered" as const, answer: trimmed, answeredAt: now }
            : item,
        );
        const structured = reflectEntry.structured;
        const confirmed = structured ? formatReflectRestatement(structured) : trimmed;
        // Draft seeding happens at reflect.drafted; confirm replaces the register
        // with the operator's edited unknowns so removed items do not reach grilling.
        const openUnknowns = structured
          ? seedUnknownsFromReflect(structured.unknowns)
          : state.openUnknowns;
        state = await this.ctx.store.record(
          {
            ...state,
            questions,
            activeQuestionId: undefined,
            openUnknowns,
            reflectBrief: {
              draft: state.reflectBrief?.draft ?? trimmed,
              structured: state.reflectBrief?.structured,
              confirmed,
              confirmedStructured: structured ?? state.reflectBrief?.confirmedStructured,
              confirmedAt: now,
            },
            phase: "grilling",
          },
          "reflect.confirmed",
          { questionId: reflectEntry.questionId },
        );
        await this.ctx.syncArtifacts(state);
        return state;
      }

      const answerById = new Map(answers.map((entry) => [entry.questionId, entry] as const));
      // Clarifications reuse the park path so they never produce a false resolution.
      const parkedIds = new Set([...parkedQuestionIds, ...clarifyById.keys()]);
      const questions = state.questions.map((item) => {
        const entry = answerById.get(item.id);
        if (entry) {
          return {
            ...item,
            status: "answered" as const,
            answer: entry.answer.trim(),
            answerOptionId: entry.optionId,
            answeredAt: now,
          };
        }
        if (parkedIds.has(item.id)) {
          return { ...item, status: "parked" as const, answeredAt: now };
        }
        return item;
      });

      const touchedBatchIds = new Set(
        [...answerById.keys(), ...parkedIds]
          .map((id) => byId.get(id)?.batchId)
          .filter((id): id is string => Boolean(id)),
      );
      const staleMs = this.ctx.config.workflow.staleAnswerMinutes * 60_000;
      let stale = false;
      for (const batchId of touchedBatchIds) {
        const batchQuestion = state.questions.find((item) => item.batchId === batchId);
        const askedAt = batchQuestion ? Date.parse(batchQuestion.askedAt) : NaN;
        if (Number.isFinite(askedAt) && Date.parse(now) - askedAt > staleMs) stale = true;
      }

      let operatorNotes = state.operatorNotes;
      let openUnknowns = state.openUnknowns;
      if (clarifyById.size > 0) {
        const addedNotes: OperatorNote[] = [];
        const addedUnknowns: OpenUnknown[] = [];
        for (const [questionId, ask] of clarifyById) {
          const question = byId.get(questionId);
          const prompt = question?.prompt?.trim() || questionId;
          const text = `Clarification requested on grill question:\nQ: ${prompt}\nAsk: ${ask}`;
          const noteId = `note-${randomUUID()}`;
          const title = ask.slice(0, 160);
          addedNotes.push({ id: noteId, text, title, at: now });
          addedUnknowns.push({
            id: `unknown-note-${randomUUID()}`,
            title,
            whyItMatters: "Raised by an operator clarification request.",
            impact: "shaping",
            status: "fog",
          });
        }
        operatorNotes = [...operatorNotes, ...addedNotes];
        openUnknowns = [...openUnknowns, ...addedUnknowns];
      }

      state = await this.ctx.store.record(
        {
          ...state,
          questions,
          activeQuestionId: undefined,
          phase: "grilling",
          operatorNotes,
          openUnknowns,
        },
        "question.answered",
        {
          questionIds: [...answerById.keys(), ...parkedIds],
          clarifiedQuestionIds: [...clarifyById.keys()],
          stale,
        },
      );

      if (stale) {
        state = await this.closeGrillEpisode(state, "grill.episode_stale_reset");
      }

      await this.ctx.syncArtifacts(state);
      return state;
    });
  }

  /** Records unprompted human input mid-grill for the next griller turn. */

  async addNote(runId: string, text: string, asUnknown = false): Promise<RunState> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Note text cannot be empty");
    return this.ctx.store.withLock(runId, async () => {
      let state = await this.ctx.store.load(runId);
      const now = new Date().toISOString();
      const note: OperatorNote = {
        id: `note-${randomUUID()}`,
        text: trimmed,
        title: asUnknown ? trimmed.slice(0, 160) : undefined,
        at: now,
      };
      const openUnknowns: OpenUnknown[] = asUnknown
        ? [
            ...state.openUnknowns,
            {
              id: `unknown-note-${randomUUID()}`,
              title: trimmed.slice(0, 160),
              whyItMatters: "Raised by an operator note.",
              impact: "shaping",
              status: "fog",
            },
          ]
        : state.openUnknowns;
      state = await this.ctx.store.record(
        { ...state, operatorNotes: [...state.operatorNotes, note], openUnknowns },
        "operator.note_added",
        { noteId: note.id, asUnknown },
      );
      await this.ctx.syncArtifacts(state);
      return state;
    });
  }

  /** Draft a no-edit recovery plan from a blocked run's failure and operator guidance. */

  async confirmGrill(runId: string, options: { feedback?: string } = {}): Promise<RunState> {
    return this.ctx.store.withLock(runId, async () => {
      let state = await this.ctx.store.load(runId);
      const pending = pendingGrillReady(state);
      if (state.phase !== "awaiting_input" || !pending) {
        throw new Error(`Run ${runId} is not awaiting grill confirmation`);
      }
      const feedback = options.feedback?.trim() ?? "";
      if (feedback) {
        const now = new Date().toISOString();
        const note: OperatorNote = {
          id: `note-${randomUUID()}`,
          text: feedback,
          title: feedback.slice(0, 160),
          at: now,
        };
        const openUnknowns: OpenUnknown[] = [
          ...state.openUnknowns,
          {
            id: `unknown-note-${randomUUID()}`,
            title: feedback.slice(0, 160),
            whyItMatters: "Raised by an operator note.",
            impact: "shaping",
            status: "fog",
          },
        ];
        state = await this.ctx.store.record(
          {
            ...state,
            grillReady: undefined,
            operatorNotes: [...state.operatorNotes, note],
            openUnknowns,
            phase: "grilling",
          },
          "grill.reopened",
          { noteId: note.id },
        );
        await this.ctx.syncArtifacts(state);
        return state;
      }
      state = await this.ctx.store.record(
        {
          ...state,
          grillReady: undefined,
          phase: "planning",
        },
        "grill.completed",
        { resolutions: state.grillResolutions.length },
      );
      await this.ctx.syncArtifacts(state);
      return state;
    });
  }

  /**
   * Accept/deny planner-proposed installs, run accepted ones via the allowlisted
   * installer, then enter executing.
   */

  async reflect(state: RunState): Promise<RunState> {
    if (state.phase !== "reflecting") {
      state = await this.ctx.store.record({ ...state, phase: "reflecting" }, "reflect.started");
    }
    const output = await this.ctx.agents.invoke({
      runId: state.runId,
      role: "reflector",
      objective: "Restate the feature idea so the operator can confirm shared understanding",
      input: { idea: state.idea },
      expectedOutput: REFLECT_EXPECTED_OUTPUT,
      schema: ReflectOutputSchema,
      knowledgeQuery: state.idea,
      knowledgeFallbackQuery: compactDomainSeed(state.idea),
      buildPrompt: false,
      signal: this.ctx.signalFor(state.runId),
    });
    const now = new Date().toISOString();
    return this.ctx.store.persistTransition(
      state.runId,
      applyReflectOutput(state, output, now, {
        batchId: `batch-${randomUUID()}`,
        questionIds: [`q-${randomUUID()}`],
      }),
    );
  }

  async grill(state: RunState): Promise<RunState> {
    const brief = state.reflectBrief?.confirmed;
    if (!brief) throw new Error("Cannot grill without a confirmed reflect brief");

    const answeredQuestions = state.questions.filter(
      (question) =>
        question.purpose === "grill" &&
        question.status === "answered" &&
        !state.grillResolutions.some((item) => item.id === question.id),
    );
    const openGrill = state.questions.find(
      (question) => question.purpose === "grill" && question.status === "open",
    );
    if (openGrill) {
      return this.ctx.store.record(
        { ...state, activeQuestionId: openGrill.id, phase: "awaiting_input" },
        "question.reopened",
        { questionId: openGrill.id },
      );
    }

    const episodeLimit = this.ctx.config.workflow.maxGrillQuestionsPerEpisode;
    const episode = state.grillEpisode;
    if (episode && !episode.closedAt && episode.questionsAnswered >= episodeLimit) {
      state = await this.closeGrillEpisode(state, "grill.episode_rolled");
    }

    // Batch-level staleness already closed the episode (see answerMany), so
    // a cold start here is sufficient.
    const coldStart = !state.grillEpisode || Boolean(state.grillEpisode.closedAt);

    const unconsumedNotes = state.operatorNotes.filter((note) => !note.consumedAt);
    if (unconsumedNotes.length > 0) {
      const consumedAt = new Date().toISOString();
      const consumedIds = new Set(unconsumedNotes.map((note) => note.id));
      state = await this.ctx.store.record(
        {
          ...state,
          operatorNotes: state.operatorNotes.map((note) =>
            consumedIds.has(note.id) ? { ...note, consumedAt } : note,
          ),
        },
        "operator.notes_consumed",
        { count: unconsumedNotes.length },
      );
    }

    const questionsPayload =
      answeredQuestions.length > 0
        ? {
            questions: answeredQuestions.map((question) => ({
              prompt: question.prompt,
              context: question.context,
              options: question.options,
              recommendation: question.recommendation,
              unknownId: question.unknownId,
            })),
            answers: answeredQuestions.map((question) => ({
              questionId: question.id,
              answer: question.answer,
              optionId: question.answerOptionId,
            })),
          }
        : {};
    // pendingBatchId is persisted for current runs. The fallback derives the
    // newest touched batch so an in-flight run written by an older harness can
    // still resume without dropping the human response.
    const legacyPendingBatchId = [...state.questions]
      .filter(
        (question) =>
          question.purpose === "grill" &&
          (question.status === "answered" || question.status === "parked"),
      )
      .sort((left, right) => right.askedAt.localeCompare(left.askedAt))[0]?.batchId;
    const pendingBatchId = state.grillEpisode?.pendingBatchId ?? legacyPendingBatchId;
    const respondedQuestions = state.questions.filter(
      (question) =>
        question.purpose === "grill" &&
        question.batchId === pendingBatchId &&
        (question.status === "answered" || question.status === "parked"),
    );
    const responseDelta = respondedQuestions.map((question) => ({
      questionId: question.id,
      question: question.prompt,
      status: question.status,
      ...(question.status === "answered"
        ? { answer: question.answer, optionId: question.answerOptionId }
        : {}),
    }));
    const notesPayload =
      unconsumedNotes.length > 0
        ? { operatorNotes: unconsumedNotes.map((note) => ({ text: note.text, title: note.title })) }
        : {};

    const input = {
      mode: coldStart ? "fresh_episode" : "continue",
      confirmedBrief: brief,
      resolutions: state.grillResolutions,
      openUnknowns: state.openUnknowns,
      ...questionsPayload,
      ...(responseDelta.some((response) => response.status === "parked")
        ? { parkedQuestions: responseDelta.filter((response) => response.status === "parked") }
        : {}),
      ...notesPayload,
    };

    // A retained griller already has the brief, register, rules, questions, and
    // prior answers in its conversation. Send only the human/event delta. The
    // complete `input` above remains available to the backend's cold fallback.
    const continuationInput = {
      responses: responseDelta,
      ...notesPayload,
    };

    const batchCeiling = this.ctx.config.workflow.grillQuestionsPerBatch;
    const invocation = await this.invokeGrill(state, {
      runId: state.runId,
      role: "griller",
      objective:
        answeredQuestions.length > 0
          ? "Incorporate the human answers and either ask the next batch of independent grill questions or declare ready to plan"
          : "Begin grilling from the confirmed feature brief; ask the first batch of decision-ready questions",
      input,
      continuationInput,
      constraints: [
        `Ask at most ${batchCeiling} question(s) this turn, and only if they are mutually independent. This is a ceiling, not a target — prefer fewer, and ask exactly one whenever the next decision forks on its answer.`,
      ],
      expectedOutput: GRILL_EXPECTED_OUTPUT,
      schema: GrillOutputSchema,
      knowledgeQuery: [brief, ...answeredQuestions.map((q) => `${q.prompt} ${q.answer ?? ""}`)]
        .filter(Boolean)
        .join(" "),
      knowledgeFallbackQuery: compactDomainSeed(brief),
      forceFresh: Boolean(coldStart),
      signal: this.ctx.signalFor(state.runId),
    });
    state = invocation.state;
    const output = invocation.output;

    // Parked grill questions never produce resolutions; their unknown stays parked (sticky).
    const parkedUnknownIds = state.questions
      .filter((question) => question.purpose === "grill" && question.status === "parked" && question.unknownId)
      .map((question) => question.unknownId!);

    const now = new Date().toISOString();
    const questions =
      output.status === "needs_input" ? output.questions.slice(0, batchCeiling) : [];
    const transition = applyGrillOutput(
      state,
      {
        parkedUnknownIds,
        batchCeiling,
        episodeLimit,
        batchId: output.status === "needs_input" ? `batch-${randomUUID()}` : undefined,
        questionIds:
          output.status === "needs_input"
            ? questions.map(() => `q-${randomUUID()}`)
            : undefined,
      },
      output,
      now,
    );

    const closedEpisodeId = transition.state.grillEpisode?.closedAt
      ? transition.state.grillEpisode.providerSessionId
      : undefined;
    if (
      closedEpisodeId &&
      state.grillEpisode &&
      !state.grillEpisode.closedAt &&
      state.grillEpisode.providerSessionId === closedEpisodeId
    ) {
      await this.ctx.agents.releaseProviderSession(closedEpisodeId).catch(() => undefined);
    }

    return this.ctx.store.persistTransition(state.runId, transition);
  }

  async invokeGrill(
    state: RunState,
    input: InvokeInput<GrillOutput> & { forceFresh?: boolean },
  ): Promise<{ state: RunState; output: GrillOutput }> {
    let episode = state.grillEpisode;
    const now = new Date().toISOString();
    if (input.forceFresh || !episode || episode.closedAt) {
      if (episode && !episode.closedAt) {
        await this.ctx.agents.releaseProviderSession(episode.providerSessionId).catch(() => undefined);
      }
      const nextNumber = (episode?.number ?? 0) + 1;
      state = await this.ctx.store.record(
        {
          ...state,
          grillEpisode: {
            number: nextNumber,
            questionsAnswered: 0,
            startedAt: now,
            updatedAt: now,
          },
        },
        "grill.episode_started",
        { episode: nextNumber, forceFresh: Boolean(input.forceFresh) },
      );
      episode = state.grillEpisode;
    }

    const invocation = await this.ctx.agents.invokeInEpisode({
      ...input,
      buildPrompt: false,
      providerSessionId: episode?.providerSessionId,
      previousGuidanceFingerprint: episode?.guidanceFingerprint,
    });
    const updatedAt = new Date().toISOString();
    return {
      state: {
        ...state,
        grillEpisode: {
          number: episode?.number ?? 1,
          providerSessionId: invocation.providerSessionId,
          questionsAnswered: episode?.questionsAnswered ?? 0,
          guidanceFingerprint: invocation.guidanceFingerprint ?? episode?.guidanceFingerprint,
          startedAt: episode?.startedAt ?? updatedAt,
          updatedAt,
        },
      },
      output: invocation.value,
    };
  }

  async closeGrillEpisode(
    state: RunState,
    event = "grill.episode_closed",
  ): Promise<RunState> {
    const episode = state.grillEpisode;
    if (!episode || episode.closedAt) return state;
    await this.ctx.agents.releaseProviderSession(episode.providerSessionId).catch(() => undefined);
    const now = new Date().toISOString();
    const closed: GrillEpisode = {
      ...episode,
      updatedAt: now,
      closedAt: now,
    };
    return this.ctx.store.record({ ...state, grillEpisode: closed }, event, {
      episode: episode.number,
      questionsAnswered: episode.questionsAnswered,
    });
  }

  /**
   * Asks a batch of questions in one turn: one shared batchId and askedAt.
   * Reflect always calls this with a single-item array.
   */

  async askQuestions(
    state: RunState,
    purpose: QuestionPurpose,
    drafts: Array<{
      prompt: string;
      context?: string;
      options?: HumanQuestionDraft["options"];
      recommendedOptionId?: string;
      recommendation?: string;
      draftAnswer?: string;
      unknownId?: string;
    }>,
  ): Promise<RunState> {
    if (drafts.length === 0) throw new Error("At least one question is required");
    const now = new Date().toISOString();
    const batchId = `batch-${randomUUID()}`;
    const newQuestions = drafts.map((details) => ({
      id: `q-${randomUUID()}`,
      purpose,
      prompt: details.prompt,
      context: details.context ?? "",
      options: details.options ?? [],
      recommendedOptionId: details.recommendedOptionId,
      recommendation: details.recommendation,
      draftAnswer: details.draftAnswer,
      unknownId: details.unknownId,
      batchId,
      status: "open" as const,
      askedAt: now,
    }));
    return this.ctx.store.record(
      {
        ...state,
        questions: [...state.questions, ...newQuestions],
        activeQuestionId: newQuestions[0]!.id,
        phase: "awaiting_input",
      },
      "question.asked",
      { questionIds: newQuestions.map((q) => q.id), purpose, batchId },
    );
  }
}

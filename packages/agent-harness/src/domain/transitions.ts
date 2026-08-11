import {
  formatReflectRestatement,
  seedUnknownsFromReflect,
  type BuildTask,
  type GrillOutput,
  type GrillResolution,
  type HighLevelPlan,
  type HumanQuestionDraft,
  type IssueSlicerOutput,
  type OpenUnknown,
  type OpenUnknownDraft,
  type ProposedInstall,
  type Question,
  type QuestionPurpose,
  type ReflectOutput,
  type RunPhase,
  type RunState,
} from "../domain.js";
import {
  assertAcyclic,
  assertCanAdvance,
  assertCanMarkTaskDone,
  hasOpenQuestionBatch,
  taskFrontier,
} from "./policies.js";

export type PendingEvent = { type: string; detail?: unknown; at: string };
export type TransitionResult = { state: RunState; events: PendingEvent[] };

/** Grill turn inputs that are already known before the model output is applied. */
export type GrillInput = {
  parkedUnknownIds: string[];
  batchCeiling: number;
  batchId?: string;
  questionIds?: string[];
  /** When set, a needs_input turn may roll the episode after incorporating answers. */
  episodeLimit?: number;
};

export type PlanTransitionConfig = {
  tdd: boolean;
  testCommand: string;
  branchName?: string;
};

export type QuestionBatchIds = {
  batchId: string;
  questionIds: string[];
};

/**
 * Reconciles the open-unknowns register against the griller's latest draft.
 * Absent priors: asked→resolved, parked→parked (sticky), resolved→resolved,
 * otherwise (fog/dropped)→dropped. A dropped entry that reappears recomputes
 * normally (not sticky). Entries are never deleted, only transitioned.
 */
export function reconcileUnknowns(
  previous: OpenUnknown[],
  incoming: OpenUnknownDraft[],
  askedIds: Set<string> = new Set(),
  parkedIds: Set<string> = new Set(),
): OpenUnknown[] {
  const previousById = new Map(previous.map((item) => [item.id, item] as const));
  const incomingIds = new Set(incoming.map((item) => item.id));
  const reconciled: OpenUnknown[] = incoming.map((draft) => {
    const prior = previousById.get(draft.id);
    const status: OpenUnknown["status"] = askedIds.has(draft.id)
      ? "asked"
      : parkedIds.has(draft.id) || prior?.status === "parked"
        ? "parked"
        : "fog";
    return {
      id: draft.id,
      title: draft.title,
      whyItMatters: draft.whyItMatters ?? "",
      impact: draft.impact ?? "shaping",
      status,
    };
  });
  for (const prior of previous) {
    if (incomingIds.has(prior.id)) continue;
    const status: OpenUnknown["status"] =
      prior.status === "asked"
        ? "resolved"
        : prior.status === "parked"
          ? "parked"
          : prior.status === "resolved"
            ? "resolved"
            : "dropped";
    reconciled.push({ ...prior, status });
  }
  return reconciled;
}

export function applyReflectOutput(
  state: RunState,
  output: ReflectOutput,
  now: string,
  ids: QuestionBatchIds,
): TransitionResult {
  assertCanAdvance(state);
  if (hasOpenQuestionBatch(state)) {
    throw new Error("Only one active question batch is allowed");
  }
  const questionId = ids.questionIds[0];
  if (!questionId || ids.questionIds.length !== 1) {
    throw new Error("Reflect confirmation requires exactly one question id");
  }
  const draft = formatReflectRestatement(output);
  const question: Question = {
    id: questionId,
    purpose: "reflect",
    prompt: "Edit and confirm this restatement of the feature before grilling begins.",
    context:
      "Adjust anything that is wrong or incomplete. Confirming sends this exact text into the grill-me session.",
    options: [],
    draftAnswer: draft,
    batchId: ids.batchId,
    status: "open",
    askedAt: now,
  };
  return {
    state: {
      ...state,
      phase: "awaiting_input",
      reflectBrief: { draft, structured: output },
      openUnknowns: seedUnknownsFromReflect(output.unknowns),
      questions: [...state.questions, question],
      activeQuestionId: questionId,
      updatedAt: now,
    },
    events: [
      { type: "reflect.drafted", detail: { summary: output.summary }, at: now },
      {
        type: "question.asked",
        detail: { questionIds: [questionId], purpose: "reflect", batchId: ids.batchId },
        at: now,
      },
    ],
  };
}

export function applyGrillOutput(
  state: RunState,
  input: GrillInput,
  output: GrillOutput,
  now: string,
): TransitionResult {
  assertCanAdvance(state);
  const events: PendingEvent[] = [];
  let next = state;

  const answeredQuestions = state.questions.filter(
    (question) =>
      question.purpose === "grill" &&
      question.status === "answered" &&
      !state.grillResolutions.some((item) => item.id === question.id),
  );
  if (answeredQuestions.length > 0) {
    const summaryByQuestionId = new Map(
      output.resolutionSummaries.map((item) => [item.questionId, item.summary]),
    );
    const resolutions: GrillResolution[] = answeredQuestions.map((question) => ({
      id: question.id,
      question: question.prompt,
      answer: question.answer ?? "",
      summary: summaryByQuestionId.get(question.id) ?? output.summary,
      resolvedAt: now,
    }));
    const questionsAnswered =
      (next.grillEpisode?.questionsAnswered ?? 0) + answeredQuestions.length;
    next = {
      ...next,
      grillResolutions: mergeResolutionLists(next.grillResolutions, resolutions),
      grillEpisode: next.grillEpisode
        ? {
            ...next.grillEpisode,
            questionsAnswered,
            updatedAt: now,
          }
        : next.grillEpisode,
      updatedAt: now,
    };
    events.push({
      type: "grill.answers_incorporated",
      detail: {
        questionIds: answeredQuestions.map((question) => question.id),
        questionsAnswered,
      },
      at: now,
    });
  }

  if (output.status === "ready_to_plan") {
    const fromOutput = output.resolutions.map((item) => ({
      ...item,
      resolvedAt: now,
    }));
    next = {
      ...next,
      grillResolutions: mergeResolutionLists(next.grillResolutions, fromOutput),
      openUnknowns: reconcileUnknowns(
        next.openUnknowns,
        output.openUnknowns,
        new Set(),
        new Set(input.parkedUnknownIds),
      ),
      phase: "awaiting_input",
      activeQuestionId: undefined,
      grillReady: { summary: output.summary, readyAt: now },
      updatedAt: now,
    };
    if (next.grillEpisode && !next.grillEpisode.closedAt) {
      const episode = next.grillEpisode;
      next = {
        ...next,
        grillEpisode: {
          ...episode,
          pendingBatchId: undefined,
          updatedAt: now,
          closedAt: now,
        },
      };
      events.push({
        type: "grill.episode_closed",
        detail: {
          episode: episode.number,
          questionsAnswered: episode.questionsAnswered,
        },
        at: now,
      });
    }
    events.push({
      type: "grill.ready",
      detail: { summary: output.summary, resolutions: next.grillResolutions.length },
      at: now,
    });
    return { state: next, events };
  }

  if (
    input.episodeLimit != null &&
    next.grillEpisode &&
    !next.grillEpisode.closedAt &&
    next.grillEpisode.questionsAnswered >= input.episodeLimit
  ) {
    const episode = next.grillEpisode;
    next = {
      ...next,
      grillEpisode: { ...episode, updatedAt: now, closedAt: now },
      updatedAt: now,
    };
    events.push({
      type: "grill.episode_rolled",
      detail: {
        episode: episode.number,
        questionsAnswered: episode.questionsAnswered,
      },
      at: now,
    });
  }

  if (hasOpenQuestionBatch(next)) {
    throw new Error("Only one active question batch is allowed");
  }
  const batchId = input.batchId;
  const questionIds = input.questionIds;
  if (!batchId || !questionIds) {
    throw new Error("Grill needs_input transitions require batchId and questionIds");
  }
  const drafts = output.questions.slice(0, input.batchCeiling);
  if (drafts.length === 0) {
    throw new Error("At least one question is required");
  }
  if (questionIds.length !== drafts.length) {
    throw new Error(
      `Expected ${drafts.length} question id(s) for grill batch, received ${questionIds.length}`,
    );
  }
  const askedUnknownIds = drafts
    .map((question) => question.unknownId)
    .filter((id): id is string => Boolean(id));
  const openUnknowns = reconcileUnknowns(
    next.openUnknowns,
    output.openUnknowns,
    new Set(askedUnknownIds),
    new Set(input.parkedUnknownIds),
  );
  const batch = applyQuestionBatchState(next, "grill", drafts, {
    batchId,
    questionIds,
    now,
  });
  return {
    state: {
      ...batch.state,
      openUnknowns,
      grillEpisode: batch.state.grillEpisode
        ? { ...batch.state.grillEpisode, pendingBatchId: batchId }
        : batch.state.grillEpisode,
    },
    events: [...events, ...batch.events],
  };
}

export function applyHighLevelPlan(
  state: RunState,
  plan: HighLevelPlan,
  now: string,
): TransitionResult {
  assertCanAdvance(state);
  if (hasOpenQuestionBatch(state)) {
    throw new Error("Only one active question batch is allowed");
  }
  return {
    state: {
      ...state,
      plan,
      planReady: { summary: plan.summary, readyAt: now },
      planFeedback: undefined,
      phase: "awaiting_input",
      updatedAt: now,
    },
    events: [
      {
        type: "plan.created",
        detail: { summary: plan.summary },
        at: now,
      },
    ],
  };
}

export function applyPlan(
  state: RunState,
  output: IssueSlicerOutput,
  now: string,
  config: PlanTransitionConfig,
): TransitionResult {
  assertCanAdvance(state);
  if (hasOpenQuestionBatch(state)) {
    throw new Error("Only one active question batch is allowed");
  }
  const tasks = materializeTasks(output, config);
  assertAcyclic(tasks);
  const proposedInstalls = materializeProposedInstalls(output.proposedInstalls ?? []);
  const nextPhase: RunPhase = proposedInstalls.length > 0 ? "awaiting_input" : "executing";
  if (nextPhase === "executing") {
    // Empty frontier with pending tasks is rejected before execution begins.
    if (taskFrontier(tasks).length === 0) {
      throw new Error("Build frontier is empty while pending tasks remain");
    }
  }
  return {
    state: {
      ...state,
      tasks,
      proposedInstalls,
      branchName: config.branchName ?? state.branchName,
      phase: nextPhase,
      updatedAt: now,
    },
    events: [
      {
        type: "tasks.materialized",
        detail: {
          tasks: tasks.length,
          tdd: tasks.filter((task) => task.tdd).length,
          proposedInstalls: proposedInstalls.length,
          summary: output.summary,
        },
        at: now,
      },
    ],
  };
}

/** Apply human answers without allowing answered questions to reopen. */
export function applyQuestionAnswers(
  state: RunState,
  answers: Array<{ questionId: string; answer: string; answerOptionId?: string }>,
  now: string,
): TransitionResult {
  assertCanAdvance(state);
  const byId = new Map(state.questions.map((question) => [question.id, question] as const));
  const answeredIds = new Set<string>();
  const questions = state.questions.map((question) => {
    const entry = answers.find((item) => item.questionId === question.id);
    if (!entry) return question;
    if (question.status === "answered") {
      throw new Error(`Question ${question.id} is already answered and cannot be reopened`);
    }
    if (question.status !== "open" && question.status !== "parked") {
      throw new Error(`Question ${question.id} cannot accept an answer from status ${question.status}`);
    }
    answeredIds.add(question.id);
    return {
      ...question,
      status: "answered" as const,
      answer: entry.answer,
      answerOptionId: entry.answerOptionId,
      answeredAt: now,
    };
  });
  for (const entry of answers) {
    if (!byId.has(entry.questionId)) {
      throw new Error(`Unknown question ${entry.questionId}`);
    }
  }
  return {
    state: {
      ...state,
      questions,
      activeQuestionId: questions.find((question) => question.status === "open")?.id,
      updatedAt: now,
    },
    events: [
      {
        type: "question.answered",
        detail: { questionIds: [...answeredIds] },
        at: now,
      },
    ],
  };
}

export function applyTaskDone(
  state: RunState,
  taskId: string,
  now: string,
  detail: { commitSha?: string } = {},
): TransitionResult {
  assertCanAdvance(state);
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Unknown task ${taskId}`);
  assertCanMarkTaskDone(task);
  const nextTask: BuildTask = {
    ...task,
    status: "done",
    step: "done",
    commitSha: detail.commitSha ?? task.commitSha,
  };
  return {
    state: {
      ...state,
      tasks: state.tasks.map((item) => (item.id === taskId ? nextTask : item)),
      updatedAt: now,
    },
    events: [
      {
        type: "task.committed",
        detail: { taskId, step: "done", commitSha: nextTask.commitSha },
        at: now,
      },
    ],
  };
}

export function materializeTasks(
  output: {
    tasks: Array<{
      id: string;
      title: string;
      description: string;
      acceptanceCriteria: string[];
      affectedPaths?: string[];
      blockedBy: string[];
      tdd?: boolean;
      testCommand?: string;
    }>;
  },
  config: PlanTransitionConfig,
): BuildTask[] {
  const idMap = new Map<string, string>();
  const used = new Set<string>();
  for (const [index, task] of output.tasks.entries()) {
    let id = safeId(task.id, `task-${index + 1}`);
    let suffix = 2;
    while (used.has(id)) {
      id = `${safeId(task.id, `task-${index + 1}`)}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    idMap.set(task.id, id);
  }
  return output.tasks.map((task) => ({
    id: idMap.get(task.id)!,
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    affectedPaths: task.affectedPaths ?? [],
    blockedBy: task.blockedBy.map((id) => idMap.get(id) ?? id),
    tdd: task.tdd ?? config.tdd,
    testCommand: task.testCommand ?? config.testCommand,
    status: "pending" as const,
    step: "pending" as const,
    attempts: { tests: 0, implementation: 0, review: 0 },
    evidence: [],
    testPaths: [],
    redCheckpointPaths: [],
    changedFiles: [],
    redCheckpointHistory: [],
    seenEvidenceFingerprints: [],
    seenRepairEdges: [],
    acceptedTestRepairFingerprints: [],
    integrityViolationCount: 0,
  }));
}

export function materializeProposedInstalls(
  installs: Array<{
    id: string;
    manager: ProposedInstall["manager"];
    packages: string[];
    reason: string;
    command?: string;
  }>,
): ProposedInstall[] {
  const used = new Set<string>();
  return installs.map((item, index) => {
    let id = safeId(item.id, `install-${index + 1}`);
    let suffix = 2;
    while (used.has(id)) {
      id = `${safeId(item.id, `install-${index + 1}`)}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    return {
      id,
      manager: item.manager,
      packages: item.packages,
      reason: item.reason,
      ...(item.command ? { command: item.command } : {}),
    };
  });
}

function applyQuestionBatchState(
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
  ids: QuestionBatchIds & { now: string },
): TransitionResult {
  if (hasOpenQuestionBatch(state)) {
    throw new Error("Only one active question batch is allowed");
  }
  if (drafts.length === 0) throw new Error("At least one question is required");
  const newQuestions: Question[] = drafts.map((details, index) => ({
    id: ids.questionIds[index]!,
    purpose,
    prompt: details.prompt,
    context: details.context ?? "",
    options: details.options ?? [],
    recommendedOptionId: details.recommendedOptionId,
    recommendation: details.recommendation,
    draftAnswer: details.draftAnswer,
    unknownId: details.unknownId,
    batchId: ids.batchId,
    status: "open" as const,
    askedAt: ids.now,
  }));
  return {
    state: {
      ...state,
      questions: [...state.questions, ...newQuestions],
      activeQuestionId: newQuestions[0]!.id,
      phase: "awaiting_input",
      updatedAt: ids.now,
    },
    events: [
      {
        type: "question.asked",
        detail: {
          questionIds: newQuestions.map((question) => question.id),
          purpose,
          batchId: ids.batchId,
        },
        at: ids.now,
      },
    ],
  };
}

function mergeResolutions(
  existing: GrillResolution[],
  next: GrillResolution,
): GrillResolution[] {
  return [...existing.filter((item) => item.id !== next.id), next];
}

function mergeResolutionLists(
  existing: GrillResolution[],
  additions: GrillResolution[],
): GrillResolution[] {
  let result = existing;
  for (const item of additions) result = mergeResolutions(result, item);
  return result;
}

function safeId(value: string, fallback: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || fallback;
}

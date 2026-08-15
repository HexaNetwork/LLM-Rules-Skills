import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export type SmokeLifecycle = {
  create: boolean;
  send: boolean;
  stream: boolean;
  wait: boolean;
  resume: boolean;
  cancel: boolean;
  dispose: boolean;
};

export type SafeSdkDiagnosticSource =
  | "stream"
  | "result"
  | "run"
  | "conversation"
  | "exception";

export type SafeSdkDiagnostic = {
  source: SafeSdkDiagnosticSource;
  type?: string;
  code?: string;
  message?: string;
};

export type SmokeLifecycleStageEvidence = {
  stage: string;
  status: "started" | "completed" | "failed" | "unsupported";
  diagnostic?: SafeSdkDiagnostic;
};

export type CursorProviderSdkRuntimeEvidence = {
  containerized: boolean;
  platform: NodeJS.Platform;
  arch: string;
  cwd: string;
  sandboxEnabled: boolean;
  sdkHelper: string;
};

export type CredentialAbsenceObservationSource =
  | "none"
  | "stream"
  | "result"
  | "conversation";

export type CredentialAbsencePhaseEvidence = {
  phase: "direct" | "delegated";
  providerCompleted: boolean;
  toolSearchAttempted: boolean;
  taskAttempted: boolean;
  nestedTaskObserved: boolean;
  completionMarkerObserved: boolean;
  keyShapedCredentialObserved: boolean;
  /** Which SDK observation channel produced the behavioral evidence above. */
  observationSource?: CredentialAbsenceObservationSource;
  /**
   * A stream transport error is recorded separately from `failure`: the phase
   * can still be proven from `conversation()`, and every behavioral
   * requirement above still has to be met on that channel.
   */
  streamFailure?: string;
  failure?: string;
};

export type CursorProviderCredentialAbsenceEvidence = {
  direct: CredentialAbsencePhaseEvidence;
  delegated: CredentialAbsencePhaseEvidence;
};

export type CursorProviderSdkSmokeResult = {
  ok: boolean;
  lifecycle: SmokeLifecycle;
  credentialAbsence: CursorProviderCredentialAbsenceEvidence;
  gaps: string[];
  runtime: CursorProviderSdkRuntimeEvidence;
  diagnostics: SafeSdkDiagnostic[];
  lifecycleStages: SmokeLifecycleStageEvidence[];
  error?: string;
};

const CONTAINER_WORKSPACE = "/workspace";
const LINUX_SDK_HELPER = "@cursor/sdk-linux-x64";
const SDK_PHASE_TIMEOUT_MS = 2 * 60_000;
const CREDENTIAL_ABSENCE_WAIT_TIMEOUT_MS = 5 * 60_000;
const SAFE_DIAGNOSTIC_TEXT_LIMIT = 500;
const CREDENTIAL_SEARCH_RESULT_MARKER = "CREDENTIAL_SEARCH_RESULT=ABSENT";
export const CURSOR_PROVIDER_SMOKE_PROGRESS_PREFIX = "CURSOR_PROVIDER_SMOKE_PROGRESS=";
const KEY_SHAPED_VALUE =
  /\b(?:cursor_[A-Za-z0-9_-]{12,}|key_[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9]{12,})\b/i;

type SmokeRunResult = {
  status: string;
  result?: unknown;
  error?: unknown;
};

/**
 * Published while the smoke is in flight so a hard process failure can still
 * emit the lifecycle evidence that was already proven.
 */
let activeSmokeSnapshot: (() => CursorProviderSdkSmokeResult) | undefined;

/**
 * Number of in-flight failure traps. Process-level failures raised while a
 * trap is active belong to that trap's operation, so the command-level handler
 * must not pre-empt it by exiting first.
 */
let activeFailureTraps = 0;

export function isCursorProviderFailureTrapActive(): boolean {
  return activeFailureTraps > 0;
}

type SmokeRun = {
  status: string;
  error?: unknown;
  supports(operation: "stream" | "wait" | "cancel" | "conversation"): boolean;
  unsupportedReason(
    operation: "stream" | "wait" | "cancel" | "conversation",
  ): string | undefined;
  stream(): AsyncIterable<unknown>;
  wait(): Promise<SmokeRunResult>;
  cancel(): Promise<void>;
  conversation(): Promise<unknown>;
};

export function buildCursorProviderSdkOptions(input: {
  token: string;
  model: string;
  /** Lifecycle smoke stays tool-free; absence phases need the default tool surface. */
  allowTools?: boolean;
}): {
  apiKey: string;
  model: { id: string };
  tools?: never[];
  local: {
    cwd: string;
    sandboxOptions: { enabled: true };
    enableAgentRetries: false;
  };
} {
  return {
    apiKey: input.token,
    model: { id: input.model },
    ...(input.allowTools ? {} : { tools: [] as never[] }),
    local: {
      cwd: CONTAINER_WORKSPACE,
      sandboxOptions: { enabled: true },
      enableAgentRetries: false,
    },
  };
}

export async function runCursorProviderSdkSmokeChild(): Promise<CursorProviderSdkSmokeResult> {
  const token = process.env.CURSOR_PROVIDER_BROKER_TOKEN?.trim();
  const backendUrl = process.env.CURSOR_BACKEND_URL?.trim();
  const model = process.env.CURSOR_PROVIDER_SMOKE_MODEL?.trim();
  const receivedHostApiKey = Boolean(process.env.CURSOR_API_KEY);
  delete process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_PROVIDER_BROKER_TOKEN;
  const runtime = await inspectRuntimeEvidence();
  if (!token || !backendUrl || !model) {
    throw new Error("Provider smoke child configuration is incomplete");
  }
  if (receivedHostApiKey || process.argv.some((arg) => /^CURSOR_API_KEY=/i.test(arg))) {
    throw new Error("Provider smoke child received forbidden CURSOR_API_KEY material");
  }
  const lifecycle = emptySmokeLifecycle();
  const gaps: string[] = [];
  const diagnostics: SafeSdkDiagnostic[] = [];
  const lifecycleStages: SmokeLifecycleStageEvidence[] = [];
  const credentialAbsence: CursorProviderCredentialAbsenceEvidence = {
    direct: emptyCredentialAbsenceEvidence("direct"),
    delegated: emptyCredentialAbsenceEvidence("delegated"),
  };
  activeSmokeSnapshot = () => ({
    ok: false,
    lifecycle,
    credentialAbsence,
    gaps,
    runtime,
    diagnostics: dedupeDiagnostics(diagnostics),
    lifecycleStages,
  });
  let runtimeError: string | undefined;
  if (
    !runtime.containerized ||
    runtime.platform !== "linux" ||
    runtime.arch !== "x64" ||
    runtime.cwd !== CONTAINER_WORKSPACE ||
    runtime.sandboxEnabled !== true ||
    runtime.sdkHelper !== LINUX_SDK_HELPER
  ) {
    runtimeError =
      "Provider SDK contract requires the hardened Linux x64 worker container at /workspace";
  }
  let first: {
    agentId: string;
    send(message: string, options?: Record<string, unknown>): Promise<SmokeRun>;
    close(): void;
    [Symbol.asyncDispose](): Promise<void>;
  } | undefined;
  let resumed: typeof first;
  try {
    if (runtimeError) throw new Error(runtimeError);
    const sdk = await import("@cursor/sdk");
    sdk.Cursor.configure({ local: { useHttp1ForAgent: true } });
    const options = buildCursorProviderSdkOptions({ token, model });
    first = await runStage("create", sdk.Agent.create(options), lifecycleStages);
    lifecycle.create = true;
    const run = await runStage(
      "send",
      first.send(
        "Provider contract smoke. Do not use tools. Reply with the single word OK.",
        { mode: "agent" },
      ),
      lifecycleStages,
    );
    lifecycle.send = true;
    let streamDiagnostic: SafeSdkDiagnostic | undefined;
    if (run.supports("stream")) {
      streamDiagnostic = await runStage("stream", consume(run.stream()), lifecycleStages);
      if (streamDiagnostic) diagnostics.push(streamDiagnostic);
      lifecycle.stream = true;
    } else {
      const detail = `stream unsupported: ${run.unsupportedReason("stream") ?? "no reason"}`;
      gaps.push(detail);
      lifecycleStages.push({
        stage: "stream",
        status: "unsupported",
        diagnostic: {
          source: "run",
          type: "UnsupportedRunOperation",
          code: "stream_unsupported",
          message: safeDiagnosticText(detail),
        },
      });
    }
    const firstResult = await runStage<SmokeRunResult>(
      "wait",
      run.wait(),
      lifecycleStages,
    );
    // `wait` evidence means the SDK operation resolved. Terminal success is a
    // separate assertion; an error result must not be mislabeled as a wait gap.
    lifecycle.wait = true;
    if (firstResult.status !== "finished") {
      const diagnostic = await collectRunFailureDiagnostic(
        run,
        firstResult,
        streamDiagnostic,
        lifecycleStages,
      );
      if (diagnostic) diagnostics.push(diagnostic);
      lifecycleStages.push({
        stage: "initial-run",
        status: "failed",
        ...(diagnostic ? { diagnostic } : {}),
      });
      throw new Error(formatTerminalRunFailure("initial run", firstResult.status, diagnostic));
    }

    const firstAgentId = first.agentId;
    await runStage("dispose-first", first[Symbol.asyncDispose](), lifecycleStages);
    lifecycle.dispose = true;
    first = undefined;
    resumed = await runStage(
      "resume",
      sdk.Agent.resume(firstAgentId, options),
      lifecycleStages,
    );
    lifecycle.resume = true;
    const resumedRun = await runStage(
      "resume-send",
      resumed.send(
        "Provider contract resume smoke. Do not use tools. Reply with the single word OK.",
        { mode: "agent" },
      ),
      lifecycleStages,
    );
    lifecycle.send = true;
    const resumedResult = await runStage<SmokeRunResult>(
      "resume-wait",
      resumedRun.wait(),
      lifecycleStages,
    );
    if (resumedResult.status !== "finished") {
      const diagnostic = await collectRunFailureDiagnostic(
        resumedRun,
        resumedResult,
        undefined,
        lifecycleStages,
      );
      if (diagnostic) diagnostics.push(diagnostic);
      lifecycleStages.push({
        stage: "resumed-run",
        status: "failed",
        ...(diagnostic ? { diagnostic } : {}),
      });
      throw new Error(formatTerminalRunFailure("resumed run", resumedResult.status, diagnostic));
    }

    const cancelRun = await runStage(
      "cancel-send",
      resumed.send(
        "Provider cancellation contract smoke. Do not use tools. Count slowly from 1 to 100 before replying OK.",
        { mode: "agent" },
      ),
      lifecycleStages,
    );
    if (cancelRun.supports("cancel")) {
      if (cancelRun.status !== "running") {
        const diagnostic: SafeSdkDiagnostic = {
          source: "run",
          type: "CancelPrecondition",
          code: "run_not_in_flight",
          message: `Cancellation run was already ${safeDiagnosticText(cancelRun.status)}`,
        };
        diagnostics.push(diagnostic);
        lifecycleStages.push({ stage: "cancel", status: "failed", diagnostic });
        throw new Error(
          formatTerminalRunFailure("cancellation run", cancelRun.status, diagnostic),
        );
      }
      await runStage("cancel", cancelRun.cancel(), lifecycleStages);
      const cancelResult = await runStage<SmokeRunResult>(
        "cancel-wait",
        cancelRun.wait(),
        lifecycleStages,
      );
      if (cancelResult.status !== "cancelled") {
        const diagnostic = await collectRunFailureDiagnostic(
          cancelRun,
          cancelResult,
          undefined,
          lifecycleStages,
        );
        if (diagnostic) diagnostics.push(diagnostic);
        lifecycleStages.push({
          stage: "cancel-terminal",
          status: "failed",
          ...(diagnostic ? { diagnostic } : {}),
        });
        throw new Error(
          formatTerminalRunFailure("cancellation run", cancelResult.status, diagnostic),
        );
      }
      lifecycle.cancel = true;
      lifecycleStages.push({ stage: "cancel-terminal", status: "completed" });
    } else {
      const detail = `cancel unsupported: ${cancelRun.unsupportedReason("cancel") ?? "no reason"}`;
      gaps.push(detail);
      lifecycleStages.push({
        stage: "cancel",
        status: "unsupported",
        diagnostic: {
          source: "run",
          type: "UnsupportedRunOperation",
          code: "cancel_unsupported",
          message: safeDiagnosticText(detail),
        },
      });
    }
    await runStage("dispose", resumed[Symbol.asyncDispose](), lifecycleStages);
    resumed = undefined;
    lifecycle.dispose = true;

    // Absence phases need the default tool surface. Keep them on a separate
    // agent so the proven tool-free lifecycle path stays isolated.
    const absenceOptions = buildCursorProviderSdkOptions({
      token,
      model,
      allowTools: true,
    });
    const isolatedAbsence = await runCredentialAbsencePhases({
      createAgent: () => sdk.Agent.create(absenceOptions),
      model,
      brokerToken: token,
      lifecycleStages,
      gaps,
    });
    credentialAbsence.direct = isolatedAbsence.direct;
    credentialAbsence.delegated = isolatedAbsence.delegated;

    return {
      ok:
        lifecycle.create &&
        lifecycle.send &&
        lifecycle.stream &&
        lifecycle.wait &&
        lifecycle.resume &&
        lifecycle.cancel &&
        lifecycle.dispose &&
        credentialAbsencePassed(credentialAbsence.direct) &&
        credentialAbsencePassed(credentialAbsence.delegated),
      lifecycle,
      credentialAbsence,
      gaps,
      runtime,
      diagnostics,
      lifecycleStages,
    };
  } catch (error) {
    const diagnostic = extractSafeSdkDiagnostic(error, "exception");
    if (diagnostic) diagnostics.push(diagnostic);
    return {
      ok: false,
      lifecycle,
      credentialAbsence,
      gaps,
      runtime,
      diagnostics: dedupeDiagnostics(diagnostics),
      lifecycleStages,
      error: safeError(error),
    };
  } finally {
    await cleanupAgent(resumed, "cleanup-resumed", lifecycleStages);
    await cleanupAgent(first, "cleanup-first", lifecycleStages);
    activeSmokeSnapshot = undefined;
  }
}

/**
 * Runs the smoke and guarantees exactly one JSON result line, including when
 * the SDK kills the process from a background task. Both the container CLI
 * command and direct module execution go through this entry point.
 */
export async function runCursorProviderSdkSmokeChildCommand(
  options: {
    write?: (line: string) => void;
    exit?: (code: number) => void;
  } = {},
): Promise<number> {
  const write =
    options.write ??
    ((line: string): void => {
      process.stdout.write(line);
    });
  const exit = options.exit ?? ((code: number): void => process.exit(code));
  let emitted = false;
  const emit = (result: CursorProviderSdkSmokeResult): number => {
    if (!emitted) {
      emitted = true;
      write(`${JSON.stringify(result)}\n`);
    }
    return result.ok ? 0 : 2;
  };
  const fatal = (error: unknown): void => {
    if (isCursorProviderFailureTrapActive()) return;
    emit(snapshotSmokeFailure(error));
    exit(2);
  };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
  try {
    return emit(await runCursorProviderSdkSmokeChild());
  } catch (error) {
    return emit(snapshotSmokeFailure(error));
  } finally {
    process.off("uncaughtException", fatal);
    process.off("unhandledRejection", fatal);
  }
}

function snapshotSmokeFailure(error: unknown): CursorProviderSdkSmokeResult {
  const snapshot = activeSmokeSnapshot?.();
  if (snapshot) return { ...snapshot, ok: false, error: safeError(error) };
  return {
    ok: false,
    lifecycle: emptySmokeLifecycle(),
    credentialAbsence: {
      direct: emptyCredentialAbsenceEvidence("direct"),
      delegated: emptyCredentialAbsenceEvidence("delegated"),
    },
    gaps: [],
    runtime: {
      containerized: false,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd().replaceAll("\\", "/"),
      sandboxEnabled: false,
      sdkHelper: "unknown",
    },
    diagnostics: [],
    lifecycleStages: [],
    error: safeError(error),
  };
}

function emptySmokeLifecycle(): SmokeLifecycle {
  return {
    create: false,
    send: false,
    stream: false,
    wait: false,
    resume: false,
    cancel: false,
    dispose: false,
  };
}

export async function runCredentialAbsencePhase(input: {
  agent: {
    send(message: string, options?: Record<string, unknown>): Promise<SmokeRun>;
  };
  phase: CredentialAbsencePhaseEvidence["phase"];
  model: string;
  brokerToken: string;
  lifecycleStages: SmokeLifecycleStageEvidence[];
  /**
   * The live proof intentionally waits without attaching a concurrent stream
   * consumer. This opt-in keeps stream recovery testable without making the
   * tool-enabled transport depend on the failing stream endpoint.
   */
  observeStream?: boolean;
  /** Tool search and delegated-task execution need longer than lifecycle stages. */
  waitTimeoutMs?: number;
}): Promise<CredentialAbsencePhaseEvidence> {
  const evidence = emptyCredentialAbsenceEvidence(input.phase);
  const observe = (event: unknown): void =>
    observeCredentialAbsenceEvent(evidence, event, input.brokerToken);
  const prompt =
    input.phase === "direct"
      ? `Credential-boundary proof. Use your available tools to search every worker-visible source for CURSOR_API_KEY or a reusable Cursor credential: environment, argv, mounts, filesystem (including /run/secrets), /proc, workspace, logs/events, and exported artifacts. Never print any discovered value. After actually searching, reply only ${CREDENTIAL_SEARCH_RESULT_MARKER}; if anything credential-shaped is found, reply only CREDENTIAL_SEARCH_RESULT=PRESENT.`
      : `Credential-boundary proof. Use the task/subagent tool exactly once and do not perform the search yourself. Instruct the delegated child to use its available tools to search every worker-visible source for CURSOR_API_KEY or a reusable Cursor credential: environment, argv, mounts, filesystem (including /run/secrets), /proc, workspace, logs/events, and exported artifacts. It must never print any discovered value. Return only ${CREDENTIAL_SEARCH_RESULT_MARKER} if the delegated search found nothing, otherwise CREDENTIAL_SEARCH_RESULT=PRESENT.`;
  let run: SmokeRun | undefined;
  let abandoned = false;
  let waitSettled = false;
  try {
    // Tool-enabled streaming currently receives Connect code 12 while the
    // tool-free lifecycle stream succeeds. Wait first, then inspect the
    // persisted conversation; this avoids a concurrent stream consumer while
    // preserving every behavioral absence gate.
    await withAsyncFailureTrap(
      async () => {
        run = await runStage(
          `${input.phase}-absence-send`,
          input.agent.send(prompt, {
            model: { id: input.model },
            mode: "agent",
          }),
          input.lifecycleStages,
        );
        if (input.observeStream && run.supports("stream")) {
          try {
            await runStage(
              `${input.phase}-absence-stream`,
              consumeCredentialAbsence(run.stream(), observe),
              input.lifecycleStages,
            );
            if (abandoned) return;
            evidence.observationSource = "stream";
          } catch (error) {
            // A broken observation transport does not imply the provider run
            // failed. Keep waiting, then recover evidence from conversation().
            evidence.streamFailure = `Credential absence stream failed: ${safeError(error)}`;
          }
        } else if (input.observeStream) {
          evidence.streamFailure =
            `Credential absence stream unsupported: ${run.unsupportedReason("stream") ?? "no reason"}`;
        }
        const result = await runStage(
          `${input.phase}-absence-wait`,
          run.wait(),
          input.lifecycleStages,
          input.waitTimeoutMs ?? CREDENTIAL_ABSENCE_WAIT_TIMEOUT_MS,
        );
        waitSettled = true;
        observe(result);
        if (
          evidence.toolSearchAttempted ||
          evidence.completionMarkerObserved ||
          evidence.taskAttempted ||
          evidence.nestedTaskObserved
        ) {
          evidence.observationSource = "result";
        }
        evidence.providerCompleted = result.status === "finished";
        if (!evidence.providerCompleted) {
          evidence.failure = `Credential absence phase ended ${safeDiagnosticText(result.status)}`;
        }
        await observeCredentialAbsenceFallback(run, evidence, observe, input);
      },
      {
        isRecoverable: isRecoverableCredentialAbsenceBackgroundFailure,
        onRecoverable: (error) => {
          evidence.streamFailure ??=
            `Credential absence background failure: ${safeError(error)}`;
        },
      },
    );
  } catch (error) {
    abandoned = true;
    evidence.failure ??= safeError(error);
    if (run && !waitSettled) {
      await cancelAndSettleCredentialAbsenceRun(run, evidence, observe, input);
      await observeCredentialAbsenceFallback(run, evidence, observe, input);
    }
    // A failure before wait settles cannot prove provider completion even if a
    // later cancellation settlement returns stale or nominally finished data.
    if (!waitSettled) evidence.providerCompleted = false;
  }
  return evidence;
}

type CredentialAbsenceAgent = {
  send(message: string, options?: Record<string, unknown>): Promise<SmokeRun>;
  [Symbol.asyncDispose](): Promise<void>;
};

export async function runCredentialAbsencePhases(input: {
  createAgent(): Promise<CredentialAbsenceAgent>;
  model: string;
  brokerToken: string;
  lifecycleStages: SmokeLifecycleStageEvidence[];
  gaps?: string[];
}): Promise<CursorProviderCredentialAbsenceEvidence> {
  const result: CursorProviderCredentialAbsenceEvidence = {
    direct: emptyCredentialAbsenceEvidence("direct"),
    delegated: emptyCredentialAbsenceEvidence("delegated"),
  };
  for (const phase of ["direct", "delegated"] as const) {
    let agent: CredentialAbsenceAgent | undefined;
    try {
      agent = await withAsyncFailureTrap(() =>
        runStage(`${phase}-absence-create`, input.createAgent(), input.lifecycleStages),
      );
      result[phase] = await runCredentialAbsencePhase({
        agent,
        phase,
        model: input.model,
        brokerToken: input.brokerToken,
        lifecycleStages: input.lifecycleStages,
      });
    } catch (error) {
      result[phase] = {
        ...result[phase],
        failure: safeError(error),
      };
    } finally {
      if (agent) {
        await withAsyncFailureTrap(() =>
          cleanupAgent(agent, `${phase}-absence-dispose`, input.lifecycleStages),
        ).catch((error: unknown) => input.gaps?.push(safeError(error)));
      }
    }
  }
  return result;
}

async function cancelAndSettleCredentialAbsenceRun(
  run: SmokeRun,
  evidence: CredentialAbsencePhaseEvidence,
  observe: (event: unknown) => void,
  input: {
    phase: CredentialAbsencePhaseEvidence["phase"];
    lifecycleStages: SmokeLifecycleStageEvidence[];
  },
): Promise<void> {
  if (run.supports("cancel") && run.status === "running") {
    try {
      await runStage(
        `${input.phase}-absence-cancel`,
        run.cancel(),
        input.lifecycleStages,
      );
    } catch (error) {
      evidence.failure ??= `Credential absence cancellation failed: ${safeError(error)}`;
    }
  }
  if (!run.supports("wait")) return;
  try {
    const result = await runStage(
      `${input.phase}-absence-settle`,
      run.wait(),
      input.lifecycleStages,
    );
    observe(result);
    evidence.providerCompleted = result.status === "finished";
  } catch (error) {
    evidence.failure ??= `Credential absence settlement failed: ${safeError(error)}`;
  }
}

/**
 * The stream is the primary observation channel. When it breaks, the same
 * behavioral evidence is re-read from the run conversation so a transport
 * failure cannot silently drop the tool-search and absence-marker proof.
 */
async function observeCredentialAbsenceFallback(
  run: SmokeRun,
  evidence: CredentialAbsencePhaseEvidence,
  observe: (event: unknown) => void,
  input: {
    phase: CredentialAbsencePhaseEvidence["phase"];
    lifecycleStages: SmokeLifecycleStageEvidence[];
  },
): Promise<void> {
  if (!run.supports("conversation")) {
    evidence.failure ??=
      `${evidence.streamFailure ? `${evidence.streamFailure}; ` : ""}` +
      `conversation fallback unsupported: ` +
      `${run.unsupportedReason("conversation") ?? "no reason"}`;
    return;
  }
  try {
    const conversation = await runStage(
      `${input.phase}-absence-conversation`,
      run.conversation(),
      input.lifecycleStages,
    );
    for (const message of conversationMessages(conversation)) observe(message);
    evidence.observationSource = "conversation";
  } catch (error) {
    evidence.failure ??=
      `${evidence.streamFailure}; conversation fallback failed: ${safeError(error)}`;
  }
}

function conversationMessages(conversation: unknown): unknown[] {
  if (Array.isArray(conversation)) return conversation;
  if (conversation && typeof conversation === "object") {
    const messages = (conversation as { messages?: unknown }).messages;
    if (Array.isArray(messages)) return messages;
  }
  return [conversation];
}

/**
 * Converts a process-level failure raised while `operation` is in flight into
 * a rejection of that operation instead of a process exit.
 */
export async function withAsyncFailureTrap<T>(
  operation: () => Promise<T>,
  options: {
    isRecoverable?: (error: unknown) => boolean;
    onRecoverable?: (error: unknown) => void;
  } = {},
): Promise<T> {
  let trip: ((error: unknown) => void) | undefined;
  const trap = new Promise<never>((_resolve, reject) => {
    trip = reject;
  });
  trap.catch(() => undefined);
  const onProcessFailure = (error: unknown): void => {
    if (options.isRecoverable?.(error)) {
      options.onRecoverable?.(error);
      return;
    }
    trip?.(new Error(`Provider SDK background failure: ${safeError(error)}`));
  };
  activeFailureTraps += 1;
  process.on("uncaughtException", onProcessFailure);
  process.on("unhandledRejection", onProcessFailure);
  const running = operation();
  try {
    return await Promise.race([running, trap]);
  } finally {
    running.catch(() => undefined);
    process.off("uncaughtException", onProcessFailure);
    process.off("unhandledRejection", onProcessFailure);
    activeFailureTraps -= 1;
  }
}

function isRecoverableCredentialAbsenceBackgroundFailure(error: unknown): boolean {
  const diagnostic = extractSafeSdkDiagnostic(error, "exception");
  const text = [
    diagnostic?.type,
    diagnostic?.code,
    diagnostic?.message,
    safeError(error),
  ]
    .filter(Boolean)
    .join(" ");
  return (
    /\bconnect(?:error)?\b/i.test(text) &&
    /\bunimplemented\b/i.test(text) &&
    (diagnostic?.code === "12" ||
      /\bcode\b\s*[:=]?\s*12\b/i.test(text) ||
      /\[\s*12\s*\]/.test(text))
  );
}

async function consumeCredentialAbsence(
  stream: AsyncIterable<unknown>,
  observe: (event: unknown) => void,
): Promise<void> {
  for await (const message of stream) observe(message);
}

function emptyCredentialAbsenceEvidence(
  phase: CredentialAbsencePhaseEvidence["phase"],
): CredentialAbsencePhaseEvidence {
  return {
    phase,
    providerCompleted: false,
    toolSearchAttempted: false,
    taskAttempted: false,
    nestedTaskObserved: false,
    completionMarkerObserved: false,
    keyShapedCredentialObserved: false,
    observationSource: "none",
  };
}

function credentialAbsencePassed(evidence: CredentialAbsencePhaseEvidence): boolean {
  return (
    evidence.providerCompleted &&
    evidence.toolSearchAttempted &&
    evidence.completionMarkerObserved &&
    !evidence.keyShapedCredentialObserved &&
    !evidence.failure &&
    (evidence.phase !== "delegated" ||
      (evidence.taskAttempted && evidence.nestedTaskObserved))
  );
}

export function observeCredentialAbsenceEvent(
  evidence: CredentialAbsencePhaseEvidence,
  event: unknown,
  brokerToken: string,
): void {
  const serialized = safeSerialize(event).replaceAll(brokerToken, "[BROKER_TOKEN]");
  const lowered = serialized.toLowerCase();
  const toolEvidence = /toolcall|tool_call|tool-call|tooluse|tool_use/i.test(serialized);
  const searchSurface =
    /environment|argv|mount|\/proc|filesystem|\/run\/secrets|workspace|logs?|events?|artifacts?/i.test(
      serialized,
    );
  const assistantOutput =
    /"(?:type|role)":"assistant"/i.test(serialized) ||
    (/"status":"finished"/i.test(serialized) && /"result":/i.test(serialized));
  const mentionsTask = /"?(task|subagent)"?/i.test(serialized);
  const nested = /nestedtask|nested_task|subagent|taskupdate|task_update/i.test(serialized);
  if (toolEvidence && searchSurface) evidence.toolSearchAttempted = true;
  if (mentionsTask && (toolEvidence || nested)) evidence.taskAttempted = true;
  if (nested) evidence.nestedTaskObserved = true;
  if (assistantOutput && serialized.includes(CREDENTIAL_SEARCH_RESULT_MARKER)) {
    evidence.completionMarkerObserved = true;
  }
  if (
    KEY_SHAPED_VALUE.test(serialized) ||
    (assistantOutput && /CREDENTIAL_SEARCH_RESULT=PRESENT/i.test(serialized)) ||
    (/\bauthorization\b/i.test(lowered) &&
      /\bbearer\s+(?!\[BROKER_TOKEN\])\S{12,}/i.test(serialized))
  ) {
    evidence.keyShapedCredentialObserved = true;
  }
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

async function inspectRuntimeEvidence(): Promise<CursorProviderSdkRuntimeEvidence> {
  let containerized = false;
  try {
    await access("/.dockerenv");
    containerized = true;
  } catch {
    containerized = false;
  }
  const sdkHelper =
    process.platform === "linux" && process.arch === "x64" ? LINUX_SDK_HELPER : "unavailable";
  if (sdkHelper === LINUX_SDK_HELPER) {
    try {
      await access("/opt/agent-harness/node_modules/@cursor/sdk-linux-x64");
    } catch {
      return {
        containerized,
        platform: process.platform,
        arch: process.arch,
        cwd: process.cwd().replaceAll("\\", "/"),
        sandboxEnabled: true,
        sdkHelper: "missing",
      };
    }
  }
  return {
    containerized,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd().replaceAll("\\", "/"),
    sandboxEnabled: true,
    sdkHelper,
  };
}

async function consume(stream: AsyncIterable<unknown>): Promise<SafeSdkDiagnostic | undefined> {
  let diagnostic: SafeSdkDiagnostic | undefined;
  for await (const message of stream) {
    // Retain only explicit terminal failure metadata. Assistant/user/tool
    // content and provider response bodies are never recorded.
    diagnostic = extractSafeSdkDiagnostic(message, "stream") ?? diagnostic;
  }
  return diagnostic;
}

async function runStage<T>(
  phase: string,
  promise: Promise<T>,
  evidence: SmokeLifecycleStageEvidence[],
  timeoutMs = SDK_PHASE_TIMEOUT_MS,
): Promise<T> {
  evidence.push({ stage: phase, status: "started" });
  emitProgress(phase, "started");
  try {
    const result = await bounded(phase, promise, timeoutMs);
    evidence.push({ stage: phase, status: "completed" });
    emitProgress(phase, "completed");
    return result;
  } catch (error) {
    const diagnostic = extractSafeSdkDiagnostic(error, "exception");
    evidence.push({
      stage: phase,
      status: "failed",
      ...(diagnostic ? { diagnostic } : {}),
    });
    emitProgress(phase, "failed");
    throw error;
  }
}

function emitProgress(
  stage: string,
  status: SmokeLifecycleStageEvidence["status"],
): void {
  process.stdout.write(
    `${CURSOR_PROVIDER_SMOKE_PROGRESS_PREFIX}${JSON.stringify({ stage, status })}\n`,
  );
}

function bounded<T>(
  phase: string,
  promise: Promise<T>,
  timeoutMs = SDK_PHASE_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Provider SDK ${phase} phase timed out`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function collectRunFailureDiagnostic(
  run: SmokeRun,
  result: SmokeRunResult,
  streamDiagnostic: SafeSdkDiagnostic | undefined,
  evidence: SmokeLifecycleStageEvidence[],
): Promise<SafeSdkDiagnostic | undefined> {
  const direct =
    extractSafeSdkDiagnostic(result, "result") ??
    extractSafeSdkDiagnostic(run.error, "run") ??
    streamDiagnostic;
  if (direct || !run.supports("conversation")) return direct;
  try {
    const conversation = await runStage(
      "diagnostic-conversation",
      run.conversation(),
      evidence,
    );
    return extractSafeSdkDiagnostic(conversation, "conversation");
  } catch {
    return undefined;
  }
}

async function cleanupAgent(
  agent:
    | {
        [Symbol.asyncDispose](): Promise<void>;
      }
    | undefined,
  stage: string,
  evidence: SmokeLifecycleStageEvidence[],
): Promise<void> {
  if (!agent) return;
  try {
    await bounded(stage, agent[Symbol.asyncDispose]());
    evidence.push({ stage, status: "completed" });
  } catch (error) {
    const diagnostic = extractSafeSdkDiagnostic(error, "exception");
    evidence.push({
      stage,
      status: "failed",
      ...(diagnostic ? { diagnostic } : {}),
    });
  }
}

export function extractSafeSdkDiagnostic(
  value: unknown,
  source: SafeSdkDiagnosticSource,
): SafeSdkDiagnostic | undefined {
  return extractDiagnosticCandidate(value, source, source !== "conversation", 0);
}

function extractDiagnosticCandidate(
  value: unknown,
  source: SafeSdkDiagnosticSource,
  direct: boolean,
  depth: number,
): SafeSdkDiagnostic | undefined {
  if (depth > 4 || value == null) return undefined;
  if (value instanceof Error) {
    const record = value as Error & { code?: unknown };
    return compactDiagnostic({
      source,
      type: safeDiagnosticText(value.name),
      code: safeDiagnosticScalar(record.code),
      message: safeDiagnosticText(value.message),
    });
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const diagnostic = extractDiagnosticCandidate(
        item,
        source,
        source !== "conversation" && direct,
        depth + 1,
      );
      if (diagnostic) return diagnostic;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    source === "stream" &&
    record.type === "status" &&
    typeof record.status === "string" &&
    ["ERROR", "CANCELLED", "EXPIRED"].includes(record.status.toUpperCase())
  ) {
    return compactDiagnostic({
      source,
      type: `SDKStatus:${safeDiagnosticText(record.status.toUpperCase())}`,
      code: safeDiagnosticScalar(record.code),
      message: safeDiagnosticScalar(record.message),
    });
  }
  for (const key of ["error", "failure", "diagnostic"]) {
    if (!(key in record)) continue;
    const diagnostic = extractDiagnosticCandidate(record[key], source, true, depth + 1);
    if (diagnostic) {
      return diagnostic.type
        ? diagnostic
        : { ...diagnostic, type: key === "error" ? "RunError" : "Failure" };
    }
  }
  if (!direct) return undefined;
  const message = safeDiagnosticScalar(record.message);
  const code = safeDiagnosticScalar(record.code ?? record.errorCode);
  const type = safeDiagnosticScalar(record.type ?? record.name);
  if (!message && !code) return undefined;
  return compactDiagnostic({
    source,
    type: type ?? (source === "result" || source === "run" ? "RunError" : undefined),
    code,
    message,
  });
}

export function formatTerminalRunFailure(
  label: string,
  status: string,
  diagnostic?: SafeSdkDiagnostic,
): string {
  const base = `${safeDiagnosticText(label)} ended ${safeDiagnosticText(status)}`;
  if (!diagnostic) return base;
  const details = [
    `source=${diagnostic.source}`,
    diagnostic.type ? `type=${diagnostic.type}` : undefined,
    diagnostic.code ? `code=${diagnostic.code}` : undefined,
    diagnostic.message ? `message=${diagnostic.message}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return `${base}; ${details.join("; ")}`;
}

function compactDiagnostic(input: SafeSdkDiagnostic): SafeSdkDiagnostic | undefined {
  const diagnostic = {
    source: input.source,
    ...(input.type ? { type: input.type } : {}),
    ...(input.code ? { code: input.code } : {}),
    ...(input.message ? { message: input.message } : {}),
  };
  return diagnostic.type || diagnostic.code || diagnostic.message ? diagnostic : undefined;
}

function safeDiagnosticScalar(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? safeDiagnosticText(String(value))
    : undefined;
}

function safeDiagnosticText(value: string): string {
  return value
    .replace(/\b(?:cursor_|key_|sk-)[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, SAFE_DIAGNOSTIC_TEXT_LIMIT);
}

function dedupeDiagnostics(diagnostics: SafeSdkDiagnostic[]): SafeSdkDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = JSON.stringify(diagnostic);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeError(error: unknown): string {
  const diagnostic = extractSafeSdkDiagnostic(error, "exception");
  const message = diagnostic
    ? [
        diagnostic.type,
        diagnostic.message,
        diagnostic.code ? `[${diagnostic.code}]` : undefined,
      ]
        .filter(Boolean)
        .join(": ")
    : String(error);
  return safeDiagnosticText(message).slice(0, 2_000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCursorProviderSdkSmokeChildCommand().then((code) => {
    process.exitCode = code;
  });
}

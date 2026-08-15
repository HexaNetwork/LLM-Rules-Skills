import { describe, expect, it } from "vitest";
import {
  extractSafeSdkDiagnostic,
  formatTerminalRunFailure,
  isCursorProviderFailureTrapActive,
  observeCredentialAbsenceEvent,
  runCredentialAbsencePhase,
  runCredentialAbsencePhases,
  runCursorProviderSdkSmokeChildCommand,
  type CredentialAbsencePhaseEvidence,
  type SmokeLifecycleStageEvidence,
} from "../../src/application/cursor-provider-sdk-smoke-child.js";

describe("Cursor provider SDK smoke diagnostics", () => {
  it("extracts redacted type, code, and message from a failed SDK result", () => {
    const diagnostic = extractSafeSdkDiagnostic(
      {
        status: "error",
        error: {
          code: "route_not_allowed",
          message:
            "POST failed with Bearer broker_token_never_persist and cursor_host_key_never_log",
        },
      },
      "result",
    );

    expect(diagnostic).toEqual({
      source: "result",
      type: "RunError",
      code: "route_not_allowed",
      message: "POST failed with Bearer [REDACTED] and [REDACTED]",
    });
    expect(formatTerminalRunFailure("initial run", "error", diagnostic)).toBe(
      "initial run ended error; source=result; type=RunError; code=route_not_allowed; " +
        "message=POST failed with Bearer [REDACTED] and [REDACTED]",
    );
  });

  it("extracts only explicit failure fields from conversation evidence", () => {
    const diagnostic = extractSafeSdkDiagnostic(
      [
        {
          role: "assistant",
          content: [{ type: "text", text: "arbitrary response content is not diagnostic" }],
        },
        {
          failure: {
            type: "ConfigurationError",
            code: "model_not_found",
            message: "Selected model is unavailable",
          },
        },
      ],
      "conversation",
    );

    expect(diagnostic).toEqual({
      source: "conversation",
      type: "ConfigurationError",
      code: "model_not_found",
      message: "Selected model is unavailable",
    });
  });

  it("extracts a terminal stream status without retaining non-error stream content", () => {
    expect(
      extractSafeSdkDiagnostic(
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "do not persist this" }] },
        },
        "stream",
      ),
    ).toBeUndefined();
    expect(
      extractSafeSdkDiagnostic(
        {
          type: "status",
          status: "ERROR",
          message: "upstream request failed",
        },
        "stream",
      ),
    ).toEqual({
      source: "stream",
      type: "SDKStatus:ERROR",
      message: "upstream request failed",
    });
  });

  it("records only redacted direct and delegated credential-search evidence", () => {
    const direct: CredentialAbsencePhaseEvidence = {
      phase: "direct",
      providerCompleted: false,
      toolSearchAttempted: false,
      taskAttempted: false,
      nestedTaskObserved: false,
      completionMarkerObserved: false,
      keyShapedCredentialObserved: false,
    };
    observeCredentialAbsenceEvent(
      direct,
      {
        type: "user",
        text:
          "Reply CREDENTIAL_SEARCH_RESULT=ABSENT or CREDENTIAL_SEARCH_RESULT=PRESENT",
      },
      "broker-token",
    );
    expect(direct.completionMarkerObserved).toBe(false);
    expect(direct.keyShapedCredentialObserved).toBe(false);
    observeCredentialAbsenceEvent(
      direct,
      {
        type: "tool_call",
        name: "Shell",
        arguments:
          "inspect environment argv mounts /proc filesystem workspace logs events exported artifacts",
      },
      "broker-token",
    );
    observeCredentialAbsenceEvent(
      direct,
      {
        type: "assistant",
        text: "CREDENTIAL_SEARCH_RESULT=ABSENT",
      },
      "broker-token",
    );

    const delegated: CredentialAbsencePhaseEvidence = {
      ...direct,
      phase: "delegated",
      toolSearchAttempted: false,
      taskAttempted: false,
      nestedTaskObserved: false,
      completionMarkerObserved: false,
    };
    observeCredentialAbsenceEvent(
      delegated,
      {
        type: "tool_call",
        name: "Task",
        nested_task: {
          result:
            "searched environment argv mounts /proc workspace",
        },
      },
      "broker-token",
    );
    observeCredentialAbsenceEvent(
      delegated,
      { type: "assistant", text: "CREDENTIAL_SEARCH_RESULT=ABSENT" },
      "broker-token",
    );

    expect(direct).toMatchObject({
      toolSearchAttempted: true,
      completionMarkerObserved: true,
      keyShapedCredentialObserved: false,
    });
    expect(delegated).toMatchObject({
      toolSearchAttempted: true,
      taskAttempted: true,
      nestedTaskObserved: true,
      completionMarkerObserved: true,
      keyShapedCredentialObserved: false,
    });

    observeCredentialAbsenceEvent(
      direct,
      { type: "tool_result", output: "cursor_reusable_credential_value" },
      "broker-token",
    );
    expect(direct.keyShapedCredentialObserved).toBe(true);
  });
});

describe("credential absence phase resilience", () => {
  const toolSearchEvent = {
    type: "tool_call",
    name: "Shell",
    arguments: "inspect environment argv mounts /proc filesystem workspace logs events artifacts",
  };
  const markerEvent = { type: "assistant", text: "CREDENTIAL_SEARCH_RESULT=ABSENT" };

  it("fails the phase with a failure string when stream and conversation both break", async () => {
    const lifecycleStages: SmokeLifecycleStageEvidence[] = [];
    const evidence = await runCredentialAbsencePhase({
      agent: fakeAgent({
        stream: () => failingStream(new Error("ConnectError: [unimplemented] code: 12")),
        supports: (operation) => operation !== "conversation",
        unsupportedReason: () => "conversation is not available for this run",
        wait: async () => ({ status: "finished" }),
      }),
      phase: "direct",
      model: "cursor-model",
      brokerToken: "broker-token",
      lifecycleStages,
      observeStream: true,
    });

    expect(evidence.providerCompleted).toBe(true);
    expect(evidence.streamFailure).toContain("unimplemented");
    expect(evidence.failure).toContain("conversation fallback unsupported");
    expect(evidence.toolSearchAttempted).toBe(false);
    expect(lifecycleStages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "direct-absence-stream", status: "failed" }),
        expect.objectContaining({ stage: "direct-absence-wait", status: "completed" }),
      ]),
    );
    expect(lifecycleStages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "direct-absence-cancel" }),
      ]),
    );
  });

  it("proves absence from the run conversation when only the stream transport fails", async () => {
    const lifecycleStages: SmokeLifecycleStageEvidence[] = [];
    const evidence = await runCredentialAbsencePhase({
      agent: fakeAgent({
        stream: () => failingStream(new Error("ConnectError: [unimplemented] code: 12")),
        conversation: async () => [toolSearchEvent, markerEvent],
        wait: async () => ({ status: "finished" }),
      }),
      phase: "direct",
      model: "cursor-model",
      brokerToken: "broker-token",
      lifecycleStages,
      observeStream: true,
    });

    expect(evidence).toMatchObject({
      providerCompleted: true,
      toolSearchAttempted: true,
      completionMarkerObserved: true,
      keyShapedCredentialObserved: false,
      observationSource: "conversation",
    });
    expect(evidence.streamFailure).toContain("unimplemented");
    expect(evidence.failure).toBeUndefined();
  });

  it("uses wait then conversation without opening a tool-enabled stream", async () => {
    const lifecycleStages: SmokeLifecycleStageEvidence[] = [];
    let streamOpened = false;
    const evidence = await runCredentialAbsencePhase({
      agent: fakeAgent({
        stream: () => {
          streamOpened = true;
          return failingStream(new Error("stream must not be opened"));
        },
        wait: async () => ({ status: "finished" }),
        conversation: async () => [toolSearchEvent, markerEvent],
      }),
      phase: "direct",
      model: "cursor-model",
      brokerToken: "broker-token",
      lifecycleStages,
    });

    expect(streamOpened).toBe(false);
    expect(evidence).toMatchObject({
      providerCompleted: true,
      toolSearchAttempted: true,
      completionMarkerObserved: true,
      observationSource: "conversation",
    });
    expect(lifecycleStages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "direct-absence-wait", status: "completed" }),
        expect.objectContaining({
          stage: "direct-absence-conversation",
          status: "completed",
        }),
      ]),
    );
  });

  it("keeps waiting after a background Connect unimplemented failure", async () => {
    const lifecycleStages: SmokeLifecycleStageEvidence[] = [];
    const order: string[] = [];
    let finishWait: (() => void) | undefined;
    const waitBlocked = new Promise<void>((resolve) => {
      finishWait = resolve;
    });
    const evidence = await withIsolatedProcessListeners(async () => {
      const pending = runCredentialAbsencePhase({
        agent: fakeAgent({
          stream: async function* () {},
          cancel: async () => {
            order.push("cancel");
          },
          wait: async () => {
            order.push("wait");
            await waitBlocked;
            return { status: "finished" };
          },
          conversation: async () => {
            order.push("conversation");
            return [toolSearchEvent, markerEvent];
          },
        }),
        phase: "direct",
        model: "cursor-model",
        brokerToken: "broker-token",
        lifecycleStages,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      process.emit("uncaughtException", new Error("ConnectError: [unimplemented] code: 12"));
      finishWait?.();
      return pending;
    });

    expect(order).toEqual(["wait", "conversation"]);
    expect(evidence).toMatchObject({
      providerCompleted: true,
      toolSearchAttempted: true,
      completionMarkerObserved: true,
      observationSource: "conversation",
    });
    expect(evidence.streamFailure).toContain("unimplemented");
    expect(evidence.failure).toBeUndefined();
    expect(lifecycleStages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "direct-absence-cancel" }),
      ]),
    );
  });

  it("cancels an in-flight absence run only when its wait times out", async () => {
    const lifecycleStages: SmokeLifecycleStageEvidence[] = [];
    const order: string[] = [];
    let settle: ((result: { status: string }) => void) | undefined;
    const waitResult = new Promise<{ status: string }>((resolve) => {
      settle = resolve;
    });
    const evidence = await runCredentialAbsencePhase({
      agent: fakeAgent({
        stream: async function* () {},
        cancel: async () => {
          order.push("cancel");
          settle?.({ status: "cancelled" });
        },
        wait: () => {
          order.push("wait");
          return waitResult;
        },
        conversation: async () => {
          order.push("conversation");
          return [];
        },
      }),
      phase: "direct",
      model: "cursor-model",
      brokerToken: "broker-token",
      lifecycleStages,
      waitTimeoutMs: 10,
    });

    expect(order).toEqual(["wait", "cancel", "wait", "conversation"]);
    expect(evidence.providerCompleted).toBe(false);
    expect(evidence.failure).toContain("timed out");
    expect(lifecycleStages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "direct-absence-wait", status: "failed" }),
        expect.objectContaining({ stage: "direct-absence-cancel", status: "completed" }),
      ]),
    );
  });

  it("creates and disposes a separate agent for each absence phase", async () => {
    const lifecycleStages: SmokeLifecycleStageEvidence[] = [];
    const order: string[] = [];
    let created = 0;
    const result = await runCredentialAbsencePhases({
      createAgent: async () => {
        created += 1;
        const instance = created;
        order.push(`create-${instance}`);
        const phaseEvent =
          instance === 1
            ? toolSearchEvent
            : {
                type: "tool_call",
                name: "Task",
                nested_task: { result: "searched environment argv mounts /proc workspace" },
              };
        return {
          ...fakeAgent({
            stream: async function* () {},
            wait: async () => ({ status: "finished" }),
            conversation: async () => [phaseEvent, markerEvent],
          }),
          [Symbol.asyncDispose]: async () => {
            order.push(`dispose-${instance}`);
          },
        };
      },
      model: "cursor-model",
      brokerToken: "broker-token",
      lifecycleStages,
    });

    expect(created).toBe(2);
    expect(order).toEqual(["create-1", "dispose-1", "create-2", "dispose-2"]);
    expect(result.direct).toMatchObject({
      providerCompleted: true,
      toolSearchAttempted: true,
      completionMarkerObserved: true,
    });
    expect(result.delegated).toMatchObject({
      providerCompleted: true,
      toolSearchAttempted: true,
      taskAttempted: true,
      nestedTaskObserved: true,
      completionMarkerObserved: true,
    });
  });

  it("cancels and records a fatal background process failure", async () => {
    const lifecycleStages: SmokeLifecycleStageEvidence[] = [];
    const trapActive: boolean[] = [];
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const evidence = await withIsolatedProcessListeners(async () => {
      const pending = runCredentialAbsencePhase({
        agent: fakeAgent({
          stream: async function* () {
            await blocked;
          },
          wait: async () => ({ status: "finished" }),
        }),
        phase: "direct",
        model: "cursor-model",
        brokerToken: "broker-token",
        lifecycleStages,
        observeStream: true,
      });
      const timer = setTimeout(() => {
        // The command-level handler defers to an active trap instead of
        // emitting a partial result and exiting first.
        trapActive.push(isCursorProviderFailureTrapActive());
        process.emit("uncaughtException", new Error("fatal SDK worker crash"));
      }, 5);
      try {
        return await pending;
      } finally {
        clearTimeout(timer);
      }
    });
    release?.();

    expect(trapActive).toEqual([true]);
    expect(isCursorProviderFailureTrapActive()).toBe(false);
    expect(evidence.failure).toContain("background failure");
    expect(evidence.failure).toContain("fatal SDK worker crash");
    expect(evidence.providerCompleted).toBe(false);
  });
});

describe("provider SDK smoke child command", () => {
  it("always writes exactly one JSON result line when the smoke cannot run", async () => {
    const lines: string[] = [];
    const exits: number[] = [];
    const code = await runCursorProviderSdkSmokeChildCommand({
      write: (line) => lines.push(line),
      exit: (value) => exits.push(value),
    });

    expect(code).toBe(2);
    expect(exits).toEqual([]);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "") as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBeTruthy();
  });
});

function fakeAgent(run: {
  stream: () => AsyncIterable<unknown>;
  wait: () => Promise<{ status: string; result?: unknown; error?: unknown }>;
  conversation?: () => Promise<unknown>;
  cancel?: () => Promise<void>;
  supports?: (operation: string) => boolean;
  unsupportedReason?: (operation: string) => string | undefined;
}): {
  send(message: string, options?: Record<string, unknown>): Promise<{
    status: string;
    supports(operation: "stream" | "wait" | "cancel" | "conversation"): boolean;
    unsupportedReason(
      operation: "stream" | "wait" | "cancel" | "conversation",
    ): string | undefined;
    stream(): AsyncIterable<unknown>;
    wait(): Promise<{ status: string; result?: unknown; error?: unknown }>;
    cancel(): Promise<void>;
    conversation(): Promise<unknown>;
  }>;
} {
  return {
    send: async () => ({
      status: "running",
      supports: (operation) => run.supports?.(operation) ?? true,
      unsupportedReason: (operation) => run.unsupportedReason?.(operation),
      stream: run.stream,
      wait: run.wait,
      cancel: run.cancel ?? (async () => undefined),
      conversation: run.conversation ?? (async () => []),
    }),
  };
}

async function* failingStream(error: Error): AsyncGenerator<unknown> {
  throw error;
}

/**
 * The trap installs real process listeners; isolating them keeps the emitted
 * test failure away from the runner's own crash reporting.
 */
async function withIsolatedProcessListeners<T>(run: () => Promise<T>): Promise<T> {
  const uncaught = process.listeners("uncaughtException");
  const rejected = process.listeners("unhandledRejection");
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
  try {
    return await run();
  } finally {
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
    for (const listener of uncaught) process.on("uncaughtException", listener);
    for (const listener of rejected) process.on("unhandledRejection", listener);
  }
}

import type { RunState } from "../domain.js";
import type { HostRunLifecycleService } from "../vnext/plugins/host-run-lifecycle.js";
import type { WorkerHarnessRuntime } from "./harness-engine.js";
import type { HostRunControl } from "./host-run-control.js";

export type HostDispatchOwner = "lifecycle" | "control" | "engine";

const LIFECYCLE_ACTIONS = new Set(["continue", "resume", "advance", "retry"]);
const CONTROL_ACTIONS = new Set([
  "cancel",
  "stop",
  "cleanup",
  "generate_analysis_prompt",
  "ignore_artifacts",
]);

/**
 * Classify a dashboard/CLI action onto the host owner. Worker RPC is not a
 * product lifecycle path.
 */
export function hostOwnerForAction(action: string): HostDispatchOwner {
  if (LIFECYCLE_ACTIONS.has(action)) return "lifecycle";
  if (CONTROL_ACTIONS.has(action)) return "control";
  return "engine";
}

export type DispatchHostRunActionInput = {
  action: string;
  runId: string;
  body: Record<string, unknown>;
  control: HostRunControl;
  runLifecycle: HostRunLifecycleService;
  openEngine: () => Promise<WorkerHarnessRuntime>;
};

export type HostDispatchResult = {
  state?: RunState;
  pending?: boolean;
  accepted: true;
};

/**
 * Single host dispatch for UI/CLI mutations. Lifecycle stays on the host.
 */
export async function dispatchHostRunAction(
  input: DispatchHostRunActionInput,
): Promise<HostDispatchResult> {
  const owner = hostOwnerForAction(input.action);
  if (owner === "lifecycle") {
    await input.runLifecycle.enqueue(input.runId);
    return { accepted: true, state: await input.control.status(input.runId) };
  }
  if (input.action === "cancel") {
    await input.control.writeCancelRequest(input.runId);
    const result = await input.control.cancel(input.runId);
    return { accepted: true, pending: result.pending, state: result.state };
  }
  if (input.action === "stop") {
    const state = await input.control.requestStop(input.runId);
    return { accepted: true, state };
  }
  if (input.action === "cleanup") {
    await input.control.cleanup(input.runId, {
      discard: input.body.discard === true,
    });
    return { accepted: true };
  }
  if (input.action === "generate_analysis_prompt") {
    await input.control.generateRunAnalysisPrompt(input.runId);
    return { accepted: true };
  }
  if (input.action === "ignore_artifacts") {
    const patterns = Array.isArray(input.body.patterns)
      ? input.body.patterns.filter((item): item is string => typeof item === "string")
      : [];
    const state = await input.control.setIgnoredArtifactPatterns(input.runId, patterns);
    return { accepted: true, state };
  }

  const engine = await input.openEngine();
  return {
    accepted: true,
    state: await invokeHostEngine(engine, input.runId, input.action, input.body),
  };
}

async function invokeHostEngine(
  engine: WorkerHarnessRuntime,
  runId: string,
  action: string,
  body: Record<string, unknown>,
): Promise<RunState> {
  switch (action) {
    case "answer":
      await engine.answerMany(
        runId,
        (Array.isArray(body.answers) ? body.answers : []) as Array<{
          questionId: string;
          answer: string;
          optionId?: string;
        }>,
        Array.isArray(body.parked) ? (body.parked as string[]) : undefined,
        Array.isArray(body.clarifications)
          ? (body.clarifications as Array<{ questionId: string; text: string }>)
          : undefined,
      );
      return engine.advance(runId);
    case "note":
      return engine.addNote(runId, String(body.text ?? ""), body.asUnknown === true);
    case "confirm_grill":
      await engine.confirmGrill(runId, { feedback: optionalString(body.feedback) });
      return engine.advance(runId);
    case "confirm_plan":
      await engine.confirmPlan(runId, {
        feedback: optionalString(body.feedback),
        plan: body.plan as never,
      });
      return engine.advance(runId);
    case "confirm_verification":
      await engine.confirmVerification(runId, {
        keepCurrent: body.keepCurrent === true,
        patch: body.patch as never,
        persistProjectDefaults: body.persistProjectDefaults === true,
      });
      return engine.advance(runId);
    default:
      return engine.advance(runId);
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

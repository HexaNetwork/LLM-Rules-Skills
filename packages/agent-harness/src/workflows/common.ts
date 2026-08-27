import type { AgentTurnRequest, JsonObject, JsonSchema, StepError, StepTransition } from "../types.js";

export type StepInput = {
  previous: unknown;
  runInput: JsonObject;
  effectiveConfig: JsonObject;
  outputs: Record<string, unknown>;
};

export function agentRequest(role: string, ordinal: number, prompt: string, outputSchema: JsonSchema, sessionId?: string): AgentTurnRequest {
  return { turnId: `${role}-${ordinal}`, role, sessionId, prompt, outputSchema };
}

export function blocked<State>(code: string, error: unknown): { type: "blocked"; error: StepError } {
  const detail = error instanceof Error ? error.message : String(error);
  const value: StepError = { code, message: detail, retryable: true };
  return { type: "blocked", error: value };
}

export const objectSchema = (required: string[], properties: Record<string, JsonSchema>): JsonSchema => ({ type: "object", required, properties, additionalProperties: false });
export const stringSchema: JsonSchema = { type: "string" };
export const booleanSchema: JsonSchema = { type: "boolean" };
export const arraySchema: JsonSchema = { type: "array" };

export function commandFailure(result: { exitCode: number; stderr: string; stdout: string; timedOut?: boolean }): string | undefined {
  if (result.exitCode === 0 && !result.timedOut) return undefined;
  return `${result.timedOut ? "Command timed out" : `Command exited ${result.exitCode}`}\n${(result.stderr || result.stdout).slice(-8_000)}`;
}

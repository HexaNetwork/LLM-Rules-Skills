import type { IncomingMessage, ServerResponse } from "node:http";
import { ReflectOutputSchema, type ReflectOutput } from "../../domain.js";
import { RunJobConflictError } from "../run-job-service.js";

export const SESSION_COOKIE = "harness_token";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Translate domain/job errors into HTTP responses for route handlers. */
export function httpErrorFromUnknown(error: unknown): { status: number; message: string } {
  if (error instanceof HttpError) return { status: error.status, message: error.message };
  if (error instanceof RunJobConflictError) return { status: error.status, message: error.message };
  return {
    status: 500,
    message: error instanceof Error ? error.message : String(error),
  };
}

export function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  );
  response.setHeader("Cache-Control", "no-store");
}

export function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

export function html(response: ServerResponse, value: string): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(value);
}

export function authorized(request: IncomingMessage, url: URL, token: string): boolean {
  return (
    request.headers["x-harness-token"] === token ||
    url.searchParams.get("token") === token ||
    readCookie(request, SESSION_COOKIE) === token
  );
}

export function readCookie(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(400, `${field} must be an object`);
  return value;
}

export function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${field} is required`);
  if (value.length > max) throw new HttpError(400, `${field} is too long`);
  return value.trim();
}

export function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value == null || value === "") return undefined;
  return requiredString(value, field, max);
}

export function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== "boolean") throw new HttpError(400, `${field} must be boolean`);
  return value;
}

export function optionalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value == null) return undefined;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new HttpError(400, `${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

export function optionalNonNegativeNumber(value: unknown, field: string): number | undefined {
  if (value == null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new HttpError(400, `${field} must be a non-negative number`);
  }
  return number;
}

export function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new HttpError(400, `${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function optionalStringArray(
  value: unknown,
  field: string,
  maxItemLength: number,
): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    throw new HttpError(400, `${field} must be an array of strings`);
  }
  return value.map((item, index) => requiredString(item, `${field}[${index}]`, maxItemLength));
}

const MAX_ANSWER_BATCH = 6;

/**
 * Accepts the batched dashboard shape
 * {answers: [{questionId, answer, optionId?, structured?}], parked?, clarifications?}.
 * `structured` is validated here since it is untrusted client input.
 */
export function parseAnswerBody(body: Record<string, unknown>): {
  answers: Array<{ questionId: string; answer: string; optionId?: string; structured?: ReflectOutput }>;
  parked: string[];
  clarifications: Array<{ questionId: string; text: string }>;
} {
  if (
    !Array.isArray(body.answers) &&
    !Array.isArray(body.parked) &&
    !Array.isArray(body.clarifications)
  ) {
    throw new HttpError(
      400,
      "answer body must include answers, parked, and/or clarifications arrays",
    );
  }
  const answerItems = Array.isArray(body.answers) ? body.answers : [];
  if (answerItems.length > MAX_ANSWER_BATCH) {
    throw new HttpError(400, `answers must include at most ${MAX_ANSWER_BATCH} entries`);
  }
  const parked = Array.isArray(body.parked)
    ? body.parked.map((value, index) => requiredString(value, `parked[${index}]`, 200))
    : [];
  if (parked.length > MAX_ANSWER_BATCH) {
    throw new HttpError(400, `parked must include at most ${MAX_ANSWER_BATCH} entries`);
  }
  const clarificationItems = Array.isArray(body.clarifications) ? body.clarifications : [];
  if (clarificationItems.length > MAX_ANSWER_BATCH) {
    throw new HttpError(400, `clarifications must include at most ${MAX_ANSWER_BATCH} entries`);
  }
  const clarifications = clarificationItems.map((item, index) => {
    const record = requiredRecord(item, `clarifications[${index}]`);
    return {
      questionId: requiredString(record.questionId, `clarifications[${index}].questionId`, 200),
      text: requiredString(record.text, `clarifications[${index}].text`, 20_000),
    };
  });
  const answers = answerItems.map((item, index) => {
    const record = requiredRecord(item, `answers[${index}]`);
    let structured: ReflectOutput | undefined;
    if (record.structured != null) {
      const parsed = ReflectOutputSchema.safeParse(record.structured);
      if (!parsed.success) throw new HttpError(400, `answers[${index}].structured is invalid`);
      structured = parsed.data;
    }
    return {
      questionId: requiredString(record.questionId, `answers[${index}].questionId`, 200),
      answer: requiredString(record.answer, `answers[${index}].answer`, 100_000),
      optionId: optionalString(record.optionId, `answers[${index}].optionId`, 200),
      structured,
    };
  });
  if (answers.length === 0 && parked.length === 0 && clarifications.length === 0) {
    throw new HttpError(
      400,
      "answers must include at least one entry, or parked/clarifications must be non-empty",
    );
  }
  const answerIds = new Set(answers.map((entry) => entry.questionId));
  const parkedIds = new Set(parked);
  for (const id of parkedIds) {
    if (answerIds.has(id)) {
      throw new HttpError(400, `question ${id} cannot be both answered and parked`);
    }
  }
  for (const entry of clarifications) {
    if (answerIds.has(entry.questionId) || parkedIds.has(entry.questionId)) {
      throw new HttpError(
        400,
        `question ${entry.questionId} cannot be clarified when it is also answered or parked`,
      );
    }
  }
  return { answers, parked, clarifications };
}

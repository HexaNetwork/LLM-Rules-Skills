import { z } from "zod";

export const ReflectOutputSchema = z.object({
  proposedTitle: z.string().min(1).optional(),
  summary: z.string().min(1),
  restatement: z.string().min(1),
  goal: z.string().min(1),
  users: z.array(z.string()),
  inScope: z.array(z.string()),
  outOfScope: z.array(z.string()),
  assumptions: z.array(z.string()),
  unknowns: z.array(z.string()),
});
export type ReflectOutput = z.infer<typeof ReflectOutputSchema>;

export const REFLECT_SECTIONS = [
  { id: "proposedTitle", label: "Feature title", list: false, single: true },
  { id: "restatement", label: "Restatement", list: false, single: false },
  { id: "goal", label: "Goal", list: false, single: false },
  { id: "users", label: "Users", list: true, single: false },
  { id: "inScope", label: "In scope", list: true, single: false },
  { id: "outOfScope", label: "Out of scope", list: true, single: false },
  { id: "assumptions", label: "Assumptions", list: true, single: false },
  { id: "unknowns", label: "Unknowns", list: true, single: false },
] as const;

export function formatReflectRestatement(output: ReflectOutput): string {
  const section = (title: string, lines: string[]): string =>
    lines.length ? `## ${title}\n\n${lines.map((line) => `- ${line}`).join("\n")}` : `## ${title}\n\n_None._`;
  return [
    output.restatement.trim(),
    "",
    `## Goal\n\n${output.goal.trim()}`,
    "",
    section("Users", output.users),
    "",
    section("In scope", output.inScope),
    "",
    section("Out of scope", output.outOfScope),
    "",
    section("Assumptions", output.assumptions),
    "",
    section("Unknowns", output.unknowns),
  ].join("\n");
}

export function coerceReflectOutput(raw: unknown): ReflectOutput {
  const record = asRecord(raw);
  if (!record) throw new Error("Reflector output must be a JSON object");
  const proposedTitle = firstText(record.proposedTitle, record.title);
  try {
    return ReflectOutputSchema.parse({
      ...(proposedTitle ? { proposedTitle } : {}),
      summary: firstText(record.summary),
      restatement: firstText(record.restatement, record.brief),
      goal: firstText(record.goal),
      users: asStringArray(record.users),
      inScope: asStringArray(record.inScope),
      outOfScope: asStringArray(record.outOfScope),
      assumptions: asStringArray(record.assumptions),
      unknowns: asStringArray(record.unknowns),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const detail = error.issues.map((issue) => issue.path.join(".") || "root").join(", ");
      throw new Error(`missing or invalid fields: ${detail || error.message}`);
    }
    throw error;
  }
}

export function applyReflectEdits(base: ReflectOutput, answers: Record<string, string>): ReflectOutput {
  const restatementRaw = answers.restatement?.trim();
  const restatement =
    !restatementRaw || restatementRaw === "yes" || restatementRaw === "y" ? base.restatement : restatementRaw;
  const proposedTitle = optionalText(answers.proposedTitle, base.proposedTitle);
  return ReflectOutputSchema.parse({
    ...(proposedTitle ? { proposedTitle } : {}),
    summary: keepText(answers.summary, base.summary) || restatement,
    restatement,
    goal: keepText(answers.goal, base.goal) || restatement,
    users: listField(answers.users, base.users),
    inScope: listField(answers.inScope, base.inScope),
    outOfScope: listField(answers.outOfScope, base.outOfScope),
    assumptions: listField(answers.assumptions, base.assumptions),
    unknowns: listField(answers.unknowns, base.unknowns),
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => item.trim()).filter(Boolean);
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

function keepText(raw: string | undefined, fallback: string): string {
  return raw === undefined ? fallback : raw.trim();
}

function optionalText(raw: string | undefined, fallback?: string): string | undefined {
  const value = raw === undefined ? fallback : raw.trim();
  return value || undefined;
}

function listField(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined) return fallback;
  return raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

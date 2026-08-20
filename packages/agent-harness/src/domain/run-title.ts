export const RUN_TITLE_PLACEHOLDER = "New run";
export const RUN_TITLE_MAX_LEN = 72;

export type RunTitleInput = {
  state?: {
    artifacts?: Record<string, unknown>;
  };
};

export function runTitle(run: RunTitleInput): string {
  const artifacts = run.state?.artifacts ?? {};
  const reflect = asRecord(artifacts.reflect);
  const brief = asRecord(artifacts.reflectBrief);
  const structured = asRecord(brief?.confirmedStructured) ?? asRecord(brief?.structured) ?? reflect;
  const title = compactText(structured?.proposedTitle) || compactText(structured?.title) || compactText(reflect?.proposedTitle) || compactText(reflect?.title);
  if (title) return shortenTitle(title);
  const restatement = compactText(structured?.restatement) || compactText(reflect?.restatement);
  if (restatement) return shortenTitle(restatement);
  return RUN_TITLE_PLACEHOLDER;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compactText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function shortenTitle(value: string): string {
  if (value.length <= RUN_TITLE_MAX_LEN) return value;
  return `${value.slice(0, RUN_TITLE_MAX_LEN - 3).trimEnd()}...`;
}

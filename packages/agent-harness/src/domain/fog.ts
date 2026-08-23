import { createHash } from "node:crypto";
import type { FogDraft, FogEntry, FogResolution } from "./types.js";

export function seedFog(unknowns: string[], existing: FogEntry[] = []): FogEntry[] {
  return reconcileFog(unknowns, existing);
}

/**
 * Add unknowns to the register without inferring resolution from omission.
 *
 * The register is durable state, not a projection of the latest model response.
 * Entries may only leave an open state through an operator answer/park or an
 * explicit, reasoned agent resolution.
 */
export function reconcileFog(draft: Array<string | FogDraft>, existing: FogEntry[]): FogEntry[] {
  const next: FogEntry[] = existing.map((entry) => ({ ...entry }));
  const byId = new Map(next.map((entry) => [entry.id, entry]));
  const byText = new Map(next.map((entry) => [normalize(entry.text), entry]));

  for (const item of draft) {
    const text = typeof item === "string" ? item.trim() : item.text.trim();
    const key = normalize(text);
    if (!key) continue;
    const requestedId = typeof item === "string" ? fogId(text) : item.id.trim();
    const currentById = requestedId ? byId.get(requestedId) : undefined;
    if (currentById) {
      if (normalize(currentById.text) !== key) {
        throw new Error(`Fog id ${requestedId} is already assigned to a different unknown`);
      }
      continue;
    }
    if (byText.has(key)) continue;
    const id = requestedId || fogId(text);
    const created: FogEntry = { id, text, status: "fog" };
    next.push(created);
    byId.set(id, created);
    byText.set(key, created);
  }
  return next;
}

export function markAsked(fog: FogEntry[], ids: string[]): FogEntry[] {
  const asked = new Set(ids);
  return fog.map((entry) =>
    asked.has(entry.id) && entry.status !== "resolved"
      ? { ...entry, status: "asked" as const, resolution: undefined }
      : entry,
  );
}

export function applyAnswers(
  fog: FogEntry[],
  answered: Array<Omit<FogResolution, "source">>,
  parkedIds: string[],
): FogEntry[] {
  const answeredById = new Map(answered.map((entry) => [entry.id, entry.reason]));
  const parked = new Set(parkedIds);
  return fog.map((entry) => {
    if (parked.has(entry.id)) return { ...entry, status: "parked", resolution: undefined };
    const reason = answeredById.get(entry.id);
    if (reason) return { ...entry, status: "resolved", resolution: { source: "user", reason } };
    return entry;
  });
}

export function applyCodeResolutions(
  fog: FogEntry[],
  resolutions: FogResolution[],
): FogEntry[] {
  const byId = new Map(resolutions.map((entry) => [entry.id, entry.reason.trim()]));
  return fog.map((entry) => {
    const reason = byId.get(entry.id);
    return reason
      ? { ...entry, status: "resolved", resolution: { source: "code" as const, reason } }
      : entry;
  });
}

export function openFog(fog: FogEntry[]): FogEntry[] {
  return fog.filter((entry) => entry.status === "fog" || entry.status === "asked");
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function fogId(text: string): string {
  const normalized = normalize(text);
  const slug = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28);
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 10);
  return `fog-${slug || "unknown"}-${digest}`;
}

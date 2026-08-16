import type { FogEntry } from "./types.js";

export function seedFog(unknowns: string[], existing: FogEntry[] = []): FogEntry[] {
  return reconcileFog(unknowns, existing);
}

export function reconcileFog(draft: string[], existing: FogEntry[]): FogEntry[] {
  const next: FogEntry[] = existing.map((entry) => ({ ...entry }));
  const byText = new Map(next.map((entry) => [normalize(entry.text), entry]));
  const seen = new Set<string>();

  for (const text of draft) {
    const key = normalize(text);
    if (!key) continue;
    seen.add(key);
    const current = byText.get(key);
    if (!current) {
      const created: FogEntry = { id: fogId(text), text, status: "fog" };
      next.push(created);
      byText.set(key, created);
      continue;
    }
    if (current.status === "resolved") current.status = "fog";
  }

  for (const entry of next) {
    if (entry.status === "parked") continue;
    if (!seen.has(normalize(entry.text)) && entry.status !== "resolved") {
      entry.status = "resolved";
    }
  }
  return next;
}

export function markAsked(fog: FogEntry[], texts: string[]): FogEntry[] {
  const asked = new Set(texts.map(normalize));
  return fog.map((entry) =>
    asked.has(normalize(entry.text)) && entry.status !== "resolved"
      ? { ...entry, status: "asked" as const }
      : entry,
  );
}

export function applyAnswers(
  fog: FogEntry[],
  answeredTexts: string[],
  parkedTexts: string[],
): FogEntry[] {
  const answered = new Set(answeredTexts.map(normalize));
  const parked = new Set(parkedTexts.map(normalize));
  return fog.map((entry) => {
    const key = normalize(entry.text);
    if (parked.has(key)) return { ...entry, status: "parked" };
    if (answered.has(key)) return { ...entry, status: "resolved" };
    return entry;
  });
}

export function openFog(fog: FogEntry[]): FogEntry[] {
  return fog.filter((entry) => entry.status === "fog" || entry.status === "asked");
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function fogId(text: string): string {
  return `fog-${normalize(text).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}`;
}

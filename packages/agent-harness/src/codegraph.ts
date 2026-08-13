/** Articles, pronouns, auxiliaries, prepositions, and conjunctions only. */
export const ENGLISH_STOPWORDS = [
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "nor",
  "for",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "into",
  "over",
  "under",
  "after",
  "before",
  "when",
  "where",
  "what",
  "which",
  "how",
  "why",
  "who",
  "this",
  "that",
  "these",
  "those",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "should",
  "could",
  "can",
  "may",
  "might",
  "must",
  "i",
  "we",
  "you",
  "they",
  "it",
  "its",
  "my",
  "our",
  "your",
  "their",
  "not",
  "no",
  "yes",
  "all",
  "any",
  "some",
  "more",
  "most",
  "other",
  "than",
  "then",
  "there",
  "here",
  "out",
  "up",
  "down",
  "only",
  "own",
  "same",
  "so",
  "too",
  "very",
  "also",
  "just",
  "about",
  "between",
  "among",
  "against",
  "without",
  "within",
  "across",
  "through",
  "during",
  "while",
  "until",
  "once",
  "again",
  "further",
  "each",
  "every",
  "both",
  "either",
  "neither",
  "via",
  "per",
] as const;

/** Harness process words that are noise in any project repository query. */
export const HARNESS_META_STOPWORDS = [
  "objective",
  "acceptance",
  "criteria",
  "resolution",
  "recommendation",
  "ticket",
  "grill",
  "packet",
] as const;

const QUERY_TOKEN_CAP = 12;
const MIN_QUERY_TOKENS = 2;

export function codegraphStopwordSet(extra: readonly string[] = []): Set<string> {
  return new Set(
    [...ENGLISH_STOPWORDS, ...HARNESS_META_STOPWORDS, ...extra].map((word) =>
      word.toLocaleLowerCase(),
    ),
  );
}

/**
 * Shape a free-text knowledge query into distinctive CodeGraph seeds:
 * prefer PascalCase / camelCase identifiers and dotted paths, then nouns.
 */
export function buildCodegraphQuery(
  raw: string,
  maxTokens = QUERY_TOKEN_CAP,
  extraStopwords: readonly string[] = [],
): string {
  const stopwords = codegraphStopwordSet(extraStopwords);
  const distinctive: string[] = [];
  const ordinary: string[] = [];
  const seen = new Set<string>();
  const pattern =
    /[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[a-z]+(?:[A-Z][a-z0-9]+)+|[A-Za-z][A-Za-z0-9_-]{2,}/g;
  for (const match of raw.matchAll(pattern)) {
    const token = match[0]!;
    const key = token.toLocaleLowerCase();
    if (stopwords.has(key) || seen.has(key)) continue;
    seen.add(key);
    if (isDistinctiveToken(token)) distinctive.push(token);
    else ordinary.push(token);
  }
  return [...distinctive, ...ordinary].slice(0, maxTokens).join(" ");
}

export function shapeCodegraphQuery(
  raw: string,
  fallbackQuery?: string,
  maxTokens = QUERY_TOKEN_CAP,
  extraStopwords: readonly string[] = [],
): { query: string; usedFallback: boolean; skippedReason?: string } {
  const primary = buildCodegraphQuery(raw, maxTokens, extraStopwords);
  if (isUsableQuery(primary)) {
    return { query: primary, usedFallback: false };
  }
  const fallback = fallbackQuery?.trim()
    ? buildCodegraphQuery(fallbackQuery, maxTokens, extraStopwords)
    : "";
  if (isUsableQuery(fallback)) {
    return { query: fallback, usedFallback: true };
  }
  return {
    query: "",
    usedFallback: Boolean(fallbackQuery?.trim()),
    skippedReason: "generic-query",
  };
}

/**
 * Compact a bounded domain seed from idea / destination text: prefer
 * identifier-like and distinctive tokens, drop harness meta-language.
 */
export function compactDomainSeed(
  ...parts: Array<string | undefined | null>
): string {
  const text = parts.filter((part): part is string => Boolean(part?.trim())).join(" ");
  if (!text) return "";
  return buildCodegraphQuery(text, 8);
}

function isDistinctiveToken(token: string): boolean {
  return (
    /[A-Za-z][A-Za-z0-9]*\.[A-Za-z]/.test(token) ||
    /[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+/.test(token) ||
    /[a-z]+(?:[A-Z][a-z0-9]+)+/.test(token) ||
    /_/.test(token) ||
    /-[A-Za-z]/.test(token)
  );
}

function isUsableQuery(query: string): boolean {
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.some(isDistinctiveToken)) return true;
  return tokens.length >= MIN_QUERY_TOKENS;
}

/** Pack CLI stdout under maxChars; unparseable dumps pass through until the cap. */
export function packCodegraphExcerpt(raw: string, maxChars: number): string {
  const trimmed = raw.trim();
  if (!trimmed || maxChars <= 0) return trimmed;
  if (trimmed.length <= maxChars) return trimmed;
  const sliced = trimmed.slice(0, maxChars);
  const lastBreak = Math.max(sliced.lastIndexOf("\n"), sliced.lastIndexOf("\r"));
  if (lastBreak >= Math.floor(maxChars * 0.5)) return sliced.slice(0, lastBreak);
  return sliced;
}

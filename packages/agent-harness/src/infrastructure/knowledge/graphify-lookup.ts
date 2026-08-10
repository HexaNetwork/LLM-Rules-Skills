import { buildGraphifyQuery } from "../../graphify.js";
import type { SearchResult } from "./types.js";

/**
 * Project a Graphify repository hit into the current project's SearchResult shape.
 */
export function toCurrentProjectResult(
  result: Omit<SearchResult, "scope" | "projectId" | "visibility" | "kind">,
  projectId: string,
): SearchResult {
  return { ...result, scope: "project", projectId, visibility: "private", kind: "document" };
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
  return buildGraphifyQuery(text, 8);
}

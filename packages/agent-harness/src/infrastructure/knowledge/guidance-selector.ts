import path from "node:path";
import { chunkText, normalizePath } from "./document-index.js";
import { scoreText, tokenize } from "./lexical-search.js";
import type {
  GuidanceOmission,
  GuidanceSelection,
  GuidanceSelectionAudit,
  GuidanceSelectionOptions,
  KnowledgeDocument,
} from "./types.js";

/** Prefer project guidance over otherwise-comparable global guidance (stronger than search +0.001). */
export const PROJECT_SCOPE_GUIDANCE_BONUS = 10;

export function cloneGuidanceAudit(value: GuidanceSelectionAudit): GuidanceSelectionAudit {
  return {
    selected: value.selected.map((item) => ({ ...item })),
    omittedAlwaysApply: value.omittedAlwaysApply.map((item) => ({ ...item })),
    omittedOverrides: (value.omittedOverrides ?? []).map((item) => ({ ...item })),
  };
}

export function guidanceResultCacheKey(
  query: string,
  options: unknown,
  generation: string,
): string {
  return `${query}\0${JSON.stringify(options)}\0${generation}`;
}

export function guidanceOverrideName(document: Pick<KnowledgeDocument, "source" | "guidance">): string {
  const explicit = document.guidance.name.trim().toLowerCase();
  if (explicit) return explicit;
  const normalized = normalizePath(document.source);
  if (document.guidance.kind === "skill") {
    const parts = normalized.split("/");
    const skillIndex = parts.findIndex((part) => part.toLowerCase() === "skill.md");
    if (skillIndex > 0) return parts[skillIndex - 1]!.toLowerCase();
  }
  return path.basename(normalized, path.extname(normalized)).toLowerCase();
}

export function bestGuidanceExcerpt(content: string, terms: string[], chunkSize: number): string {
  const chunks = chunkText(content, chunkSize);
  if (chunks.length === 0) return "";
  return chunks
    .map((text, index) => ({ text, index, score: scoreText(text, terms) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]!.text;
}

export function omissionReason(
  document: KnowledgeDocument,
  role: string,
  knownPaths: string[],
  terms: string[],
): string {
  const guidance = document.guidance;
  if (guidance.roles.length > 0 && !guidance.roles.includes(role)) {
    return `worker role ${role} is outside declared roles`;
  }
  if (
    guidance.kind === "rule" &&
    knownPaths.length > 0 &&
    guidance.globs.length > 0 &&
    !guidance.globs.some((glob) => knownPaths.some((filePath) => matchesGlob(glob, filePath)))
  ) {
    return "known target paths do not match the rule globs";
  }
  if (scoreText(`${document.title}\n${guidance.description}\n${document.content}`, terms) === 0) {
    return "no role, path, or lexical relevance signal";
  }
  return "not selected";
}

export function matchesGlob(glob: string, filePath: string): boolean {
  const pattern = glob.trim().replace(/^['"]|['"]$/g, "");
  if (!pattern) return false;
  const source = globToRegex(pattern);
  return new RegExp(`^${source}$`, "i").test(filePath.replaceAll("\\", "/"));
}

function globToRegex(pattern: string): string {
  let result = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        result += "(?:.*/)?";
        index += 2;
      } else {
        result += ".*";
        index += 1;
      }
    } else if (char === "*") {
      result += "[^/]*";
    } else if (char === "?") {
      result += "[^/]";
    } else if (char === "{") {
      const end = pattern.indexOf("}", index + 1);
      if (end >= 0) {
        result += `(?:${pattern.slice(index + 1, end).split(",").map(escapeRegex).join("|")})`;
        index = end;
      } else {
        result += "\\{";
      }
    } else {
      result += escapeRegex(char);
    }
  }
  return result;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

export function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((item) => item.replaceAll("\\", "/").replace(/^\.\//, "").trim()).filter(Boolean))];
}

function isVisibleToProject(
  chunk: Pick<KnowledgeDocument, "scope" | "projectId" | "visibility">,
  activeProjectId: string,
  includedProjects: string[],
): boolean {
  if (chunk.scope === "global") return true;
  if (chunk.projectId === activeProjectId) return true;
  return chunk.visibility === "shared" && includedProjects.includes(chunk.projectId ?? "");
}

export function selectGuidanceFromDocuments(
  documents: KnowledgeDocument[],
  query: string,
  options: GuidanceSelectionOptions & { chunkCharacters: number },
  defaults: { maxResults: number; maxCharacters: number; projectId: string },
): GuidanceSelectionAudit {
  const terms = [...new Set(tokenize(`${options.role} ${query}`))];
  const maxResults = options.maxResults ?? defaults.maxResults;
  const maxCharacters = options.maxCharacters ?? defaults.maxCharacters;
  if (terms.length === 0 || maxResults <= 0 || maxCharacters <= 0) {
    return { selected: [], omittedAlwaysApply: [], omittedOverrides: [] };
  }
  const activeProjectId = options.projectId ?? defaults.projectId;
  const knownPaths = uniquePaths(options.knownPaths ?? []);
  const filtered = documents.filter(
    (document) =>
      document.guidance.kind !== "document" &&
      isVisibleToProject(document, activeProjectId, options.includeProjects ?? []),
  );

  const scored = filtered
    .flatMap((document) => {
      const guidance = document.guidance;
      if (guidance.disableModelInvocation) return [];
      if (guidance.roles.length > 0 && !guidance.roles.includes(options.role)) return [];
      const matchingGlobs = guidance.globs.filter((glob) =>
        knownPaths.some((filePath) => matchesGlob(glob, filePath)),
      );
      if (guidance.kind === "rule" && knownPaths.length > 0 && guidance.globs.length > 0 && matchingGlobs.length === 0) {
        return [];
      }
      const lexicalScore = scoreText(
        `${document.title}\n${guidance.description}\n${document.content}`,
        terms,
      );
      const roleMatch = guidance.roles.includes(options.role);
      const globMatch = matchingGlobs.length > 0;
      if (!roleMatch && !globMatch && lexicalScore === 0) return [];
      const projectScope =
        document.scope === "project" &&
        (document.projectId === undefined || document.projectId === activeProjectId);
      const score =
        lexicalScore +
        (roleMatch ? 100 : 0) +
        (globMatch ? 80 : 0) +
        (guidance.alwaysApply ? 20 : 0) +
        (projectScope ? PROJECT_SCOPE_GUIDANCE_BONUS : 0);
      const reason = [
        ...(roleMatch ? ["role match"] : []),
        ...(globMatch ? [`path matches ${matchingGlobs.join(", ")}`] : []),
        ...(guidance.alwaysApply ? ["alwaysApply priority"] : []),
        ...(projectScope ? ["project scope"] : []),
        ...(lexicalScore > 0 ? ["lexical relevance"] : []),
      ].join("; ");
      return [{ document, score: Number(score.toFixed(6)), reason }];
    })
    .sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id));

  const projectGuidanceNames = new Set(
    scored
      .filter((candidate) => candidate.document.scope === "project")
      .map((candidate) => guidanceOverrideName(candidate.document)),
  );
  const omittedOverrides: GuidanceOmission[] = [];
  const candidates = scored.filter((candidate) => {
    if (candidate.document.scope !== "global") return true;
    const name = guidanceOverrideName(candidate.document);
    if (!projectGuidanceNames.has(name)) return true;
    omittedOverrides.push({
      source: candidate.document.source,
      title: candidate.document.title,
      reason: "overridden by project guidance",
    });
    return false;
  });

  let remaining = maxCharacters;
  const selected: GuidanceSelection[] = [];
  for (const candidate of candidates) {
    if (selected.length >= maxResults || remaining <= 0) break;
    const excerpt = bestGuidanceExcerpt(
      candidate.document.content,
      terms,
      options.chunkCharacters,
    ).slice(0, remaining);
    if (!excerpt) continue;
    selected.push({
      source: candidate.document.source,
      title: candidate.document.title,
      kind: candidate.document.guidance.kind as "rule" | "skill",
      excerpt,
      reason: candidate.reason,
      score: candidate.score,
    });
    remaining -= excerpt.length;
  }
  const selectedSources = new Set(selected.map((item) => item.source));
  const overriddenSources = new Set(omittedOverrides.map((item) => item.source));
  const candidateSources = new Set(candidates.map((item) => item.document.source));
  const omittedAlwaysApply = filtered
    .filter(
      (document) =>
        document.guidance.alwaysApply &&
        !selectedSources.has(document.source) &&
        !overriddenSources.has(document.source),
    )
    .map((document) => ({
      source: document.source,
      title: document.title,
      reason: candidateSources.has(document.source)
        ? "lower-ranked or omitted by the guidance budget"
        : omissionReason(document, options.role, knownPaths, terms),
    }));
  return { selected, omittedAlwaysApply, omittedOverrides };
}

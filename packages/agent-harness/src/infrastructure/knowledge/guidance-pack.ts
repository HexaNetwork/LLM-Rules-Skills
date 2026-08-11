import { guidanceOverrideName } from "./guidance-selector.js";
import type {
  CompiledGuidancePack,
  GuidanceOmission,
  GuidanceSelectionOptions,
  KnowledgeDocument,
} from "./types.js";

export type CompileRoleGuidancePackOptions = {
  assignment: NonNullable<GuidanceSelectionOptions["assignment"]>;
  maxCharacters: number;
  projectId: string;
  includeProjects?: string[];
};

/** Stable cache key fragment for a role's assignment lists. */
export function guidanceAssignmentFingerprint(
  assignment: NonNullable<GuidanceSelectionOptions["assignment"]>,
): string {
  return JSON.stringify({
    rules: assignment.rules.map((name) => name.trim().toLowerCase()),
    skills: assignment.skills.map((name) => name.trim().toLowerCase()),
  });
}

export function guidancePackCacheKey(
  role: string,
  generation: string,
  assignment: NonNullable<GuidanceSelectionOptions["assignment"]>,
  maxCharacters: number,
  projectId: string,
  includeProjects: string[] = [],
): string {
  return [
    role,
    generation,
    guidanceAssignmentFingerprint(assignment),
    String(maxCharacters),
    projectId,
    JSON.stringify(includeProjects),
  ].join("\0");
}

export function cloneCompiledGuidancePack(value: CompiledGuidancePack): CompiledGuidancePack {
  return {
    text: value.text,
    sources: [...value.sources],
    selected: value.selected.map((item) => ({ ...item })),
    missingAssignments: value.missingAssignments.map((item) => ({ ...item })),
    omittedOverrides: value.omittedOverrides.map((item) => ({ ...item })),
    ...(value.truncated ? { truncated: { ...value.truncated } } : {}),
  };
}

/** Strip a leading YAML frontmatter block; leave body unchanged when absent. */
export function stripYamlFrontmatter(content: string): string {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return content.trim();
  return content.slice(match[0].length).trim();
}

function guidanceOverrideKey(document: Pick<KnowledgeDocument, "source" | "guidance">): string {
  return `${document.guidance.kind}:${guidanceOverrideName(document)}`;
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

/**
 * Compile assigned rules/skills into one model-facing pack (no headers, reasons, or frontmatter).
 * Assignment order is authoritative: rules then skills, each list in declared order.
 */
export function compileRoleGuidancePack(
  documents: KnowledgeDocument[],
  options: CompileRoleGuidancePackOptions,
): CompiledGuidancePack {
  const ordered = [
    ...options.assignment.rules.map((name) => ({
      kind: "rule" as const,
      name: name.trim().toLowerCase(),
    })),
    ...options.assignment.skills.map((name) => ({
      kind: "skill" as const,
      name: name.trim().toLowerCase(),
    })),
  ].filter((item) => item.name.length > 0);

  if (ordered.length === 0 || options.maxCharacters <= 0) {
    return {
      text: "",
      sources: [],
      selected: [],
      missingAssignments: [],
      omittedOverrides: [],
    };
  }

  const visible = documents.filter(
    (document) =>
      document.guidance.kind !== "document" &&
      isVisibleToProject(document, options.projectId, options.includeProjects ?? []),
  );

  const byKey = new Map<string, KnowledgeDocument[]>();
  for (const document of visible) {
    const key = guidanceOverrideKey(document);
    const list = byKey.get(key) ?? [];
    list.push(document);
    byKey.set(key, list);
  }

  const omittedOverrides: GuidanceOmission[] = [];
  const missingAssignments: CompiledGuidancePack["missingAssignments"] = [];
  const selected: CompiledGuidancePack["selected"] = [];
  const bodies: string[] = [];

  for (const entry of ordered) {
    const key = `${entry.kind}:${entry.name}`;
    const candidates = byKey.get(key) ?? [];
    if (candidates.length === 0) {
      missingAssignments.push({
        kind: entry.kind,
        name: entry.name,
        reason: "no active-project or General guidance entry was found in guidance roots",
      });
      continue;
    }

    const projectDocs = candidates.filter((document) => document.scope === "project");
    const chosen = projectDocs[0] ?? candidates[0]!;
    if (chosen.scope === "project") {
      for (const candidate of candidates) {
        if (candidate.scope !== "global") continue;
        omittedOverrides.push({
          source: candidate.source,
          title: candidate.title,
          reason: "overridden by project guidance",
        });
      }
    }

    const body = stripYamlFrontmatter(chosen.content);
    selected.push({
      source: chosen.source,
      title: chosen.title,
      kind: chosen.guidance.kind as "rule" | "skill",
    });
    if (body) bodies.push(body);
  }

  let text = bodies.join("\n\n");
  let truncated: CompiledGuidancePack["truncated"];
  if (text.length > options.maxCharacters) {
    truncated = { before: text.length, after: options.maxCharacters };
    text = text.slice(0, options.maxCharacters);
  }

  return {
    text,
    sources: selected.map((item) => item.source),
    selected,
    missingAssignments,
    omittedOverrides,
    ...(truncated ? { truncated } : {}),
  };
}

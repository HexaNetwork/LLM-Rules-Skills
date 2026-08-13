import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { HarnessFailure } from "../errors.js";

export const WORKSPACE_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_EVIDENCE_FINGERPRINT_VERSION = 1 as const;
/** Max paths retained on WorkspaceEvidence / divergence diagnostics. */
export const WORKSPACE_EVIDENCE_CHANGED_PATHS_LIMIT = 40 as const;

/** Windows device / reserved basenames that cannot be used as a path segment. */
const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

export const RunWorkspaceKindSchema = z.enum(["git-worktree", "git-disabled"]);
export type RunWorkspaceKind = z.infer<typeof RunWorkspaceKindSchema>;

export const RunWorkspaceSchema = z.object({
  version: z.literal(WORKSPACE_SCHEMA_VERSION),
  kind: RunWorkspaceKindSchema,
  controlRoot: z.string().min(1),
  worktreePath: z.string().min(1).optional(),
  gitCommonDir: z.string().min(1).optional(),
  baseBranch: z.string().min(1).optional(),
  baseSha: z.string().min(1).optional(),
  branchName: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  removedAt: z.string().min(1).optional(),
});
export type RunWorkspace = z.infer<typeof RunWorkspaceSchema>;

export const WorkspaceEvidenceSchema = z.object({
  headSha: z.string().min(1),
  indexTreeSha: z.string().min(1),
  statusDigest: z.string().min(1),
  changedPaths: z.array(z.string()),
  fingerprint: z.string().min(1),
});
export type WorkspaceEvidence = z.infer<typeof WorkspaceEvidenceSchema>;

export type WorkspaceEvidenceFields = Omit<WorkspaceEvidence, "fingerprint">;

/** Resolve and normalize a workspace path for storage and comparison. */
export function canonicalizeWorkspacePath(value: string): string {
  const resolved = path.resolve(value);
  // Prefer forward slashes in persisted metadata for cross-platform readability.
  return resolved.replaceAll("\\", "/");
}

function compareKey(value: string): string {
  const canonical = canonicalizeWorkspacePath(value);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/**
 * True when `child` is exactly `parent` or a path beneath it.
 * Rejects sibling prefixes such as `worktrees` vs `worktrees-evil`.
 */
export function isWorktreePathContained(child: string, parent: string): boolean {
  const childKey = compareKey(child);
  const parentKey = compareKey(parent).replace(/\/+$/, "");
  if (childKey === parentKey) return true;
  const prefix = parentKey.endsWith("/") ? parentKey : `${parentKey}/`;
  return childKey.startsWith(prefix);
}

export function assertWorktreePathContained(child: string, parent: string): void {
  if (!isWorktreePathContained(child, parent)) {
    throw new HarnessFailure(
      `Worktree path is not contained in the configured worktree parent (${canonicalizeWorkspacePath(parent)}): ${canonicalizeWorkspacePath(child)}`,
      "workspace",
      false,
    );
  }
}

/**
 * Filesystem-safe run directory segment for `<stateRoot>/worktrees/<id>`.
 * Lowercases, replaces unsafe characters, and avoids Windows reserved names.
 */
export function sanitizeWorktreeRunId(runId: string): string {
  let safe = runId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 80);
  if (!safe) safe = "run";
  if (safe === "." || safe === ".." || safe.includes("..")) {
    safe = "run";
  }
  const base = safe.split(".")[0] ?? safe;
  if (WINDOWS_RESERVED_NAMES.has(base) || WINDOWS_RESERVED_NAMES.has(safe)) {
    const rest = safe.slice(base.length).replace(/^\./, "-");
    safe = `${base}-run${rest}`;
  }
  return safe;
}

/** Max characters retained from a feature title when building a delivery branch slug. */
export const FEATURE_TITLE_SLUG_LIMIT = 48 as const;

/**
 * Deterministic, filesystem-safe slug for a confirmed feature title.
 * Used as the human-readable segment of late-created delivery branches.
 */
export function slugifyFeatureTitle(title: string): string {
  let safe = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, FEATURE_TITLE_SLUG_LIMIT)
    .replace(/-+$/g, "");
  if (!safe) safe = "feature";
  if (WINDOWS_RESERVED_NAMES.has(safe)) {
    safe = `${safe}-feature`;
  }
  return safe;
}

/** Collision-safe short run identifier for delivery branch names (8 alphanumerics). */
export function shortRunIdForBranch(runId: string): string {
  const compact = runId.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return compact.slice(0, 8) || "run";
}

export type ProposeDeliveryBranchNameArgs = {
  branchPrefix: string;
  title: string;
  runId: string;
};

/**
 * Late delivery branch name: `<branchPrefix>/<feature-title-slug>-<shortRunId>`.
 * Freeze this name when branch creation is requested; later title edits must not rename it.
 */
export function proposeDeliveryBranchName(args: ProposeDeliveryBranchNameArgs): string {
  const prefix = args.branchPrefix.replace(/\/+$/g, "");
  const slug = slugifyFeatureTitle(args.title);
  const shortId = shortRunIdForBranch(args.runId);
  return `${prefix}/${slug}-${shortId}`;
}

export type MigrateRunWorkspaceOptions = {
  controlRoot: string;
  createdAt?: string;
};

/**
 * Parse workspace metadata. Missing records are rejected — every resumable run
 * must have an explicit git-worktree or git-disabled workspace.json.
 */
export function migrateRunWorkspace(
  value: unknown,
  options: MigrateRunWorkspaceOptions,
): RunWorkspace {
  if (value == null) {
    throw new HarnessFailure(
      "Run workspace metadata is missing. Archive the run or recreate it under a registered external harness home.",
      "workspace",
      false,
    );
  }

  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "legacy-shared"
  ) {
    throw new HarnessFailure(
      "legacy-shared workspaces are no longer supported. Archive the run or recreate it as a git-worktree run.",
      "workspace",
      false,
    );
  }

  const parsed = RunWorkspaceSchema.parse(value);
  return RunWorkspaceSchema.parse({
    ...parsed,
    controlRoot: canonicalizeWorkspacePath(parsed.controlRoot),
    worktreePath: parsed.worktreePath
      ? canonicalizeWorkspacePath(parsed.worktreePath)
      : undefined,
    gitCommonDir: parsed.gitCommonDir
      ? canonicalizeWorkspacePath(parsed.gitCommonDir)
      : undefined,
  });
}

/** Versioned, order-independent hash of structured workspace evidence fields. */
export function workspaceEvidenceFingerprint(fields: WorkspaceEvidenceFields): string {
  const paths = [...fields.changedPaths].map((p) => p.replaceAll("\\", "/")).sort();
  const payload = [
    `v${WORKSPACE_EVIDENCE_FINGERPRINT_VERSION}`,
    fields.headSha,
    fields.indexTreeSha,
    fields.statusDigest,
    paths.join("\n"),
  ].join("\0");
  const digest = createHash("sha256").update(payload).digest("hex");
  return `v${WORKSPACE_EVIDENCE_FINGERPRINT_VERSION}:${digest}`;
}

/** Build evidence with sorted paths and a stamped fingerprint. */
export function buildWorkspaceEvidence(fields: WorkspaceEvidenceFields): WorkspaceEvidence {
  const { changedPaths } = boundWorkspaceChangedPaths(fields.changedPaths);
  const normalized: WorkspaceEvidenceFields = {
    headSha: fields.headSha,
    indexTreeSha: fields.indexTreeSha,
    statusDigest: fields.statusDigest,
    changedPaths,
  };
  return WorkspaceEvidenceSchema.parse({
    ...normalized,
    fingerprint: workspaceEvidenceFingerprint(normalized),
  });
}

/** Sort, normalize, and cap diagnostic paths for evidence / messages. */
export function boundWorkspaceChangedPaths(paths: string[]): {
  changedPaths: string[];
  omittedCount: number;
} {
  const sorted = [...new Set(paths.map((p) => p.replaceAll("\\", "/")))].sort((a, b) =>
    a.localeCompare(b),
  );
  if (sorted.length <= WORKSPACE_EVIDENCE_CHANGED_PATHS_LIMIT) {
    return { changedPaths: sorted, omittedCount: 0 };
  }
  return {
    changedPaths: sorted.slice(0, WORKSPACE_EVIDENCE_CHANGED_PATHS_LIMIT),
    omittedCount: sorted.length - WORKSPACE_EVIDENCE_CHANGED_PATHS_LIMIT,
  };
}

export type WorkspaceEvidenceDiff = {
  head: boolean;
  index: boolean;
  workingFiles: boolean;
  changedPaths: string[];
  omittedCount: number;
};

/** Component-level comparison of recorded vs observed workspace evidence. */
export function diffWorkspaceEvidence(
  previous: WorkspaceEvidence,
  observed: WorkspaceEvidence,
): WorkspaceEvidenceDiff {
  const head = previous.headSha !== observed.headSha;
  const index = previous.indexTreeSha !== observed.indexTreeSha;
  const workingFiles = previous.statusDigest !== observed.statusDigest;
  if (!head && !index && !workingFiles) {
    return {
      head: false,
      index: false,
      workingFiles: false,
      changedPaths: [],
      omittedCount: 0,
    };
  }
  const bounded = boundWorkspaceChangedPaths(observed.changedPaths);
  return {
    head,
    index,
    workingFiles,
    changedPaths: bounded.changedPaths,
    omittedCount: bounded.omittedCount,
  };
}

export function describeWorkspaceDivergence(diff: WorkspaceEvidenceDiff): string {
  const parts: string[] = [];
  if (diff.head) parts.push("HEAD");
  if (diff.index) parts.push("index");
  if (diff.workingFiles) parts.push("working files");
  return parts.length > 0 ? parts.join(", ") : "fingerprint";
}

/** Operator-facing divergence message with component and path diagnostics. */
export function formatWorkspaceDivergenceMessage(
  diff: WorkspaceEvidenceDiff,
  observed: WorkspaceEvidence,
): string {
  const components = describeWorkspaceDivergence(diff);
  const bounded = boundWorkspaceChangedPaths(
    diff.changedPaths.length > 0 ? diff.changedPaths : observed.changedPaths,
  );
  const pathText =
    bounded.changedPaths.length > 0
      ? bounded.changedPaths.join(", ") +
        (bounded.omittedCount > 0 ? ` (+${bounded.omittedCount} more)` : "")
      : "(HEAD or index changed with no dirty paths)";
  return (
    `Workspace diverged in this run's worktree (${components}). ` +
    `Diverging paths: ${pathText}`
  );
}

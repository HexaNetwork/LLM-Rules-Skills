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

export const RunWorkspaceKindSchema = z.enum(["git-disabled", "host-worktree"]);
export type RunWorkspaceKind = z.infer<typeof RunWorkspaceKindSchema>;

/**
 * Git-disabled workspaces omit Git identity while retaining explicit run
 * workspace metadata for the non-Git execution path.
 */
const GitDisabledWorkspaceSchema = z.object({
  version: z.literal(WORKSPACE_SCHEMA_VERSION),
  kind: z.literal("git-disabled"),
  controlRoot: z.string().min(1),
  baseBranch: z.string().min(1).optional(),
  baseSha: z.string().min(1).optional(),
  branchName: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  removedAt: z.string().min(1).optional(),
});

/**
 * Host-owned Git worktree bind-mounted into disposable sandboxes at `/workspace`.
 * Distinct from retired pre-cutover `git-worktree` local execution.
 */
const HostWorktreeWorkspaceSchema = z.object({
  version: z.literal(WORKSPACE_SCHEMA_VERSION),
  kind: z.literal("host-worktree"),
  controlRoot: z.string().min(1),
  worktreePath: z.string().min(1),
  gitCommonDir: z.string().min(1),
  /** Worker-visible workspace root inside the sandbox. */
  workspacePath: z.literal("/workspace").default("/workspace"),
  baseSha: z.string().min(1),
  baseBranch: z.string().min(1).optional(),
  branchName: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  removedAt: z.string().min(1).optional(),
});

export const RunWorkspaceSchema = z.discriminatedUnion("kind", [
  GitDisabledWorkspaceSchema,
  HostWorktreeWorkspaceSchema,
]);
export type RunWorkspace = z.infer<typeof RunWorkspaceSchema>;
export type GitDisabledWorkspace = z.infer<typeof GitDisabledWorkspaceSchema>;
export type HostWorktreeWorkspace = z.infer<typeof HostWorktreeWorkspaceSchema>;

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

/** Filesystem-safe run id segment for host worktree directories. */
export function sanitizeWorktreeRunId(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.slice(0, 80) || "run";
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
 * Parse workspace metadata. Missing and pre-cutover records are rejected —
 * every resumable run must have explicit Docker or git-disabled metadata.
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
    ["legacy-shared", "git-worktree", "docker-clone"].includes(
      String((value as { kind?: unknown }).kind),
    )
  ) {
    throw new HarnessFailure(
      "Pre-cutover workspaces are no longer supported. Finish/export/discard the run with the pre-cutover harness, then recreate it with a host worktree.",
      "workspace",
      false,
    );
  }

  const parsed = RunWorkspaceSchema.parse(value);
  if (parsed.kind === "host-worktree") {
    return RunWorkspaceSchema.parse({
      ...parsed,
      controlRoot: canonicalizeWorkspacePath(parsed.controlRoot),
      worktreePath: canonicalizeWorkspacePath(parsed.worktreePath),
      gitCommonDir: canonicalizeWorkspacePath(parsed.gitCommonDir),
      workspacePath: "/workspace",
    });
  }
  return RunWorkspaceSchema.parse({
    ...parsed,
    controlRoot: canonicalizeWorkspacePath(parsed.controlRoot),
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
    `Workspace diverged in this run's Docker workspace (${components}). ` +
    `Diverging paths: ${pathText}`
  );
}

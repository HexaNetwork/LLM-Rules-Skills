import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * Deterministic execution-image evidence (ADR 0015 §4).
 * Inspect only bounded, allowlisted manifests/lockfiles on the host — never run
 * an unsandboxed host image-profiler agent (avoids image/bootstrap circularity).
 */

export const EXECUTION_IMAGE_EVIDENCE_VERSION = 1 as const;

/** Root-level manifests + lockfiles considered for stack profiling. */
export const EXECUTION_IMAGE_MANIFEST_CANDIDATES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile.lock",
  "poetry.lock",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
] as const;

const MAX_FILE_BYTES = 512 * 1024;
const EXCERPT_LIMIT = 4_000;

export type ExecutionImageStackId = "node" | "python" | "go" | "rust" | "jvm";

export type ExecutionImageManifestEntry = {
  path: string;
  present: boolean;
  /** Normalized content hash when present (sha256 hex). */
  contentHash?: string;
  /** Bounded excerpt for operator review / debugging. */
  excerpt?: string;
  byteLength?: number;
};

export type ExecutionImageEvidence = {
  version: typeof EXECUTION_IMAGE_EVIDENCE_VERSION;
  repositoryRoot: string;
  manifests: ExecutionImageManifestEntry[];
  /** Distinct stacks detected from present root manifests. */
  stacks: ExecutionImageStackId[];
  /** True when zero or multiple primary stacks — operator gate required. */
  ambiguous: boolean;
  collectedAt: string;
};

const STACK_MARKERS: ReadonlyArray<{
  stack: ExecutionImageStackId;
  basenames: ReadonlySet<string>;
  /** Primary manifests that count toward ambiguity (lockfiles alone do not). */
  primary: boolean;
}> = [
  { stack: "node", basenames: new Set(["package.json"]), primary: true },
  {
    stack: "node",
    basenames: new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]),
    primary: false,
  },
  {
    stack: "python",
    basenames: new Set(["pyproject.toml", "requirements.txt"]),
    primary: true,
  },
  {
    stack: "python",
    basenames: new Set(["Pipfile.lock", "poetry.lock"]),
    primary: false,
  },
  { stack: "go", basenames: new Set(["go.mod"]), primary: true },
  { stack: "go", basenames: new Set(["go.sum"]), primary: false },
  { stack: "rust", basenames: new Set(["Cargo.toml"]), primary: true },
  { stack: "rust", basenames: new Set(["Cargo.lock"]), primary: false },
  {
    stack: "jvm",
    basenames: new Set([
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts",
    ]),
    primary: true,
  },
];

/**
 * Collect bounded stack evidence from allowlisted project files only.
 * Does not walk nested packages — image profiles are root-centric for MVP.
 */
export async function collectExecutionImageEvidence(
  repositoryRoot: string,
  options: { collectedAt?: string } = {},
): Promise<ExecutionImageEvidence> {
  const root = path.resolve(repositoryRoot);
  const manifests: ExecutionImageManifestEntry[] = [];

  for (const relative of EXECUTION_IMAGE_MANIFEST_CANDIDATES) {
    const absolute = path.join(root, relative);
    const normalized = toPosix(relative);
    try {
      await access(absolute);
      const raw = await readFile(absolute);
      if (raw.byteLength > MAX_FILE_BYTES) {
        manifests.push({
          path: normalized,
          present: true,
          byteLength: raw.byteLength,
          excerpt: `[omitted: file exceeds ${MAX_FILE_BYTES} bytes]`,
          contentHash: createHash("sha256").update(raw).digest("hex"),
        });
        continue;
      }
      const text = raw.toString("utf8");
      manifests.push({
        path: normalized,
        present: true,
        byteLength: raw.byteLength,
        contentHash: createHash("sha256").update(normalizeManifestContent(normalized, text)).digest("hex"),
        excerpt: excerptFor(normalized, text),
      });
    } catch {
      manifests.push({ path: normalized, present: false });
    }
  }

  const present = manifests.filter((entry) => entry.present);
  const primaryStacks = detectPrimaryStacks(present);
  const allStacks = detectAllStacks(present);
  const stacks = primaryStacks.length > 0 ? primaryStacks : allStacks;
  const ambiguous = stacks.length !== 1;

  return {
    version: EXECUTION_IMAGE_EVIDENCE_VERSION,
    repositoryRoot: root,
    manifests,
    stacks,
    ambiguous,
    collectedAt: options.collectedAt ?? new Date().toISOString(),
  };
}

/** Canonical profile inputs used for hashing / cache keys. */
export function canonicalProfileInputs(evidence: ExecutionImageEvidence): {
  version: number;
  stacks: ExecutionImageStackId[];
  files: Array<{ path: string; contentHash: string }>;
} {
  const files = evidence.manifests
    .filter((entry) => entry.present && entry.contentHash)
    .map((entry) => ({ path: entry.path, contentHash: entry.contentHash! }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    version: evidence.version,
    stacks: [...evidence.stacks].sort(),
    files,
  };
}

export function hashExecutionImageProfile(evidence: ExecutionImageEvidence): string {
  const canonical = canonicalProfileInputs(evidence);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function detectPrimaryStacks(
  present: ReadonlyArray<{ path: string }>,
): ExecutionImageStackId[] {
  const stacks = new Set<ExecutionImageStackId>();
  for (const entry of present) {
    const base = path.posix.basename(toPosix(entry.path));
    for (const marker of STACK_MARKERS) {
      if (marker.primary && marker.basenames.has(base)) stacks.add(marker.stack);
    }
  }
  return [...stacks].sort();
}

function detectAllStacks(
  present: ReadonlyArray<{ path: string }>,
): ExecutionImageStackId[] {
  const stacks = new Set<ExecutionImageStackId>();
  for (const entry of present) {
    const base = path.posix.basename(toPosix(entry.path));
    for (const marker of STACK_MARKERS) {
      if (marker.basenames.has(base)) stacks.add(marker.stack);
    }
  }
  return [...stacks].sort();
}

/**
 * Normalize lockfile/manifest text for stable hashing (trim trailing whitespace,
 * normalize newlines; for package.json sort keys lightly via JSON round-trip).
 */
export function normalizeManifestContent(relativePath: string, raw: string): string {
  const base = path.posix.basename(toPosix(relativePath));
  const normalizedNewlines = raw.replace(/\r\n/g, "\n").trimEnd() + "\n";
  if (base === "package.json") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return `${JSON.stringify(sortJson(parsed))}\n`;
    } catch {
      return normalizedNewlines;
    }
  }
  return normalizedNewlines;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJson(record[key]);
    }
    return sorted;
  }
  return value;
}

function excerptFor(relative: string, raw: string): string {
  const base = path.posix.basename(toPosix(relative));
  if (base === "package.json") {
    try {
      const parsed = JSON.parse(raw) as {
        name?: unknown;
        engines?: unknown;
        packageManager?: unknown;
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      return JSON.stringify(
        {
          name: typeof parsed.name === "string" ? parsed.name : undefined,
          engines: parsed.engines,
          packageManager: parsed.packageManager,
          dependencyKeys: parsed.dependencies ? Object.keys(parsed.dependencies).sort() : [],
          devDependencyKeys: parsed.devDependencies
            ? Object.keys(parsed.devDependencies).sort()
            : [],
        },
        null,
        2,
      ).slice(0, EXCERPT_LIMIT);
    } catch {
      return raw.slice(0, EXCERPT_LIMIT);
    }
  }
  return raw.slice(0, EXCERPT_LIMIT);
}

function toPosix(relative: string): string {
  return relative.replaceAll("\\", "/");
}

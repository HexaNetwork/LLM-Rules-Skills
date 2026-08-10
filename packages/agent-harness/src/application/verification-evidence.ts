import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type {
  CommandEvidence,
  VerificationEvidence,
  VerificationSettingsSnapshot,
} from "../domain.js";

/** Greenfield / empty-suite runners often exit non-zero with this wording. */
const NO_TESTS_FOUND = /no tests found|no test files found/i;
const COMMAND_NOT_LAUNCHED = /command not found|not recognized/i;

/**
 * True when a pre-planner `commands.test` baseline is acceptable:
 * exit 0, or runner output reports an empty suite (greenfield).
 * Command-not-launched and timeouts remain failures.
 */
export function isVerificationBaselineAcceptable(evidence: CommandEvidence): boolean {
  const output = `${evidence.stdout}\n${evidence.stderr}`;
  if (COMMAND_NOT_LAUNCHED.test(output)) return false;
  if (evidence.passed) return true;
  return NO_TESTS_FOUND.test(output);
}

const MANIFEST_CANDIDATES = [
  "package.json",
  "pyproject.toml",
  "pytest.ini",
  "go.mod",
  "Cargo.toml",
  "Makefile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradlew",
  "gradlew.bat",
] as const;

const MANIFEST_BASENAMES = new Set<string>(MANIFEST_CANDIDATES);

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".gradle",
  "target",
  ".agent-harness",
  "out",
  "bin",
  "obj",
  ".idea",
  "coverage",
  "vendor",
]);

const EXCERPT_LIMIT = 2_000;
const WRAPPER_EXCERPT = "[wrapper script present]";
const MAX_WALK_DEPTH = 6;
const MAX_NESTED_MANIFEST_HITS = 25;
const MAX_SAMPLE_TEST_PATHS = 20;

const STACK_MARKERS: ReadonlyArray<{ stack: string; basenames: ReadonlySet<string> }> = [
  { stack: "node", basenames: new Set(["package.json"]) },
  { stack: "python", basenames: new Set(["pyproject.toml", "pytest.ini"]) },
  { stack: "go", basenames: new Set(["go.mod"]) },
  { stack: "rust", basenames: new Set(["Cargo.toml"]) },
  { stack: "make", basenames: new Set(["Makefile"]) },
  { stack: "maven", basenames: new Set(["pom.xml"]) },
  {
    stack: "gradle",
    basenames: new Set([
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts",
      "gradlew",
      "gradlew.bat",
    ]),
  },
];

/**
 * Collect lightweight, language-agnostic verification evidence under repositoryRoot.
 * The harness only gathers facts; the project-profiler proposes settings.
 */
export async function collectVerificationEvidence(
  repositoryRoot: string,
  currentSettings: VerificationSettingsSnapshot,
): Promise<VerificationEvidence> {
  const manifests: VerificationEvidence["manifests"] = [];
  const seenPresent = new Set<string>();

  for (const relative of MANIFEST_CANDIDATES) {
    const absolute = path.join(repositoryRoot, relative);
    const normalized = toPosix(relative);
    try {
      await access(absolute);
      const raw = await readFile(absolute, "utf8");
      manifests.push({
        path: normalized,
        present: true,
        excerpt: excerptForManifest(normalized, raw),
      });
      seenPresent.add(normalized);
    } catch {
      manifests.push({ path: normalized, present: false });
    }
  }

  const sampleTestPaths: string[] = [];
  let nestedHits = 0;

  await walkTree(repositoryRoot, repositoryRoot, 0, async (relativePosix, absolute) => {
    const base = path.posix.basename(relativePosix);
    if (
      MANIFEST_BASENAMES.has(base) &&
      !seenPresent.has(relativePosix) &&
      nestedHits < MAX_NESTED_MANIFEST_HITS
    ) {
      nestedHits += 1;
      seenPresent.add(relativePosix);
      try {
        const raw = await readFile(absolute, "utf8");
        manifests.push({
          path: relativePosix,
          present: true,
          excerpt: excerptForManifest(relativePosix, raw),
        });
      } catch {
        manifests.push({ path: relativePosix, present: true });
      }
    }
    if (sampleTestPaths.length < MAX_SAMPLE_TEST_PATHS && looksLikeTestPath(relativePosix)) {
      sampleTestPaths.push(relativePosix);
    }
  });

  return {
    manifests,
    sampleTestPaths,
    currentSettings,
    host: {
      platform: process.platform,
      isWindows: process.platform === "win32",
    },
  };
}

/**
 * True when evidence is thin, empty, or ambiguous and the profiler should inspect the tree.
 * Strong single-stack (or sample-path-only) packets stay tools-off.
 */
export function verificationEvidenceNeedsTools(evidence: VerificationEvidence): boolean {
  const stacks = detectStacks(evidence.manifests.filter((entry) => entry.present));
  if (stacks.size >= 2) return true;
  if (stacks.size === 0 && evidence.sampleTestPaths.length === 0) return true;
  return false;
}

function detectStacks(present: ReadonlyArray<{ path: string }>): Set<string> {
  const stacks = new Set<string>();
  for (const entry of present) {
    const base = path.posix.basename(toPosix(entry.path));
    for (const marker of STACK_MARKERS) {
      if (marker.basenames.has(base)) stacks.add(marker.stack);
    }
  }
  return stacks;
}

async function walkTree(
  repositoryRoot: string,
  currentDir: string,
  depth: number,
  onFile: (relativePosix: string, absolute: string) => Promise<void>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absolute = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || depth >= MAX_WALK_DEPTH) continue;
      await walkTree(repositoryRoot, absolute, depth + 1, onFile);
      continue;
    }
    if (entry.isFile()) {
      const relativePosix = toPosix(path.relative(repositoryRoot, absolute));
      if (relativePosix.length === 0 || relativePosix.startsWith("..")) continue;
      await onFile(relativePosix, absolute);
    }
  }
}

function excerptForManifest(relative: string, raw: string): string {
  const base = path.posix.basename(toPosix(relative));
  if (base === "gradlew" || base === "gradlew.bat") {
    return WRAPPER_EXCERPT;
  }
  if (base === "package.json") {
    try {
      const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown>; name?: unknown };
      const scripts =
        parsed.scripts && typeof parsed.scripts === "object"
          ? Object.fromEntries(
              Object.entries(parsed.scripts).filter(([, value]) => typeof value === "string"),
            )
          : {};
      return JSON.stringify(
        {
          name: typeof parsed.name === "string" ? parsed.name : undefined,
          scripts,
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

function looksLikeTestPath(relativePosix: string): boolean {
  const base = path.posix.basename(relativePosix);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(base)) return true;
  if (/_test\.(go|py)$/i.test(base)) return true;
  if (/Tests?\.java$/i.test(base)) return true;
  if (/(^|\/)(__tests__|tests?|src\/main\/test|src\/test)\//i.test(relativePosix)) {
    return /\.(java|kt|ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i.test(base);
  }
  return false;
}

function toPosix(relative: string): string {
  return relative.replaceAll("\\", "/");
}

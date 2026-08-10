import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { VerificationEvidence, VerificationSettingsSnapshot } from "../domain.js";

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
] as const;

const EXCERPT_LIMIT = 2_000;

/**
 * Collect lightweight, language-agnostic verification evidence under repositoryRoot.
 * The harness only gathers facts; the project-profiler proposes settings.
 */
export async function collectVerificationEvidence(
  repositoryRoot: string,
  currentSettings: VerificationSettingsSnapshot,
): Promise<VerificationEvidence> {
  const manifests: VerificationEvidence["manifests"] = [];
  for (const relative of MANIFEST_CANDIDATES) {
    const absolute = path.join(repositoryRoot, relative);
    try {
      await access(absolute);
      const raw = await readFile(absolute, "utf8");
      manifests.push({
        path: relative.replaceAll("\\", "/"),
        present: true,
        excerpt: excerptForManifest(relative, raw),
      });
    } catch {
      manifests.push({ path: relative.replaceAll("\\", "/"), present: false });
    }
  }
  return { manifests, currentSettings };
}

function excerptForManifest(relative: string, raw: string): string {
  if (relative === "package.json") {
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

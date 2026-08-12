import path from "node:path";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { git } from "./git.js";
import type { ProjectFixture } from "./project-fixture.js";

export type DiagnosticCapture = {
  /** Relative paths under the fixture that were copied into the diagnostic bundle. */
  artifactPaths: string[];
  /** Optional dashboard / HTTP errors observed during the test. */
  serverErrors?: string[];
  /** Vitest / Playwright retry count when known. */
  retryCount?: number;
};

export type DiagnosticContext = {
  noteServerError(message: string): void;
  setRetryCount(count: number): void;
};

/**
 * Runs an integration/E2E body and, on failure, copies the fixture's
 * `.agent-harness/` tree into Git-ignored `test-results/` with a manifest.
 * Successful runs leave diagnostics alone so fixtures can clean themselves.
 */
export async function withDiagnosticArtifacts<T>(
  options: {
    testName: string;
    fixture: ProjectFixture;
    resultsRoot?: string;
  },
  body: (diagnostics: DiagnosticContext) => Promise<T>,
): Promise<T> {
  const serverErrors: string[] = [];
  let retryCount = 0;
  const diagnostics: DiagnosticContext = {
    noteServerError(message) {
      serverErrors.push(message);
    },
    setRetryCount(count) {
      retryCount = count;
    }};

  try {
    return await body(diagnostics);
  } catch (error) {
    await captureFailureArtifacts({
      testName: options.testName,
      fixture: options.fixture,
      resultsRoot: options.resultsRoot,
      error,
      serverErrors,
      retryCount}).catch(() => undefined);
    throw error;
  }
}

async function captureFailureArtifacts(options: {
  testName: string;
  fixture: ProjectFixture;
  resultsRoot?: string;
  error: unknown;
  serverErrors: string[];
  retryCount: number;
}): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = options.testName
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "unnamed";
  const packageRoot = path.resolve(import.meta.dirname, "../..");
  const resultsRoot = path.resolve(options.resultsRoot ?? path.join(packageRoot, "test-results"));
  const destination = path.join(resultsRoot, `${stamp}_${safeName}`);
  await mkdir(destination, { recursive: true });

  const harnessSource = path.join(options.fixture.root, ".agent-harness");
  const harnessDestination = path.join(destination, ".agent-harness");
  const artifactPaths: string[] = [];
  try {
    await cp(harnessSource, harnessDestination, { recursive: true, force: true });
    artifactPaths.push(".agent-harness/");
  } catch (copyError) {
    artifactPaths.push(
      `/.agent-harness missing or unreadable: ${
        copyError instanceof Error ? copyError.message : String(copyError)
      }`,
    );
  }

  let gitStatus: string | undefined;
  let gitLog: string | undefined;
  try {
    gitStatus = await git(options.fixture.root, "status", "--short");
  } catch {
    // Fixture may not be a git repository.
  }
  try {
    gitLog = await git(options.fixture.root, "log", "-5", "--oneline");
  } catch {
    // No commits yet.
  }

  const manifest = {
    testName: options.testName,
    time: new Date().toISOString(),
    fixturePath: options.fixture.root,
    destination,
    artifactPaths,
    serverErrors: options.serverErrors,
    retryCount: options.retryCount,
    error:
      options.error instanceof Error
        ? { name: options.error.name, message: options.error.message, stack: options.error.stack }
        : { message: String(options.error) },
    git: {
      status: gitStatus,
      log: gitLog}};
  await writeFile(path.join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

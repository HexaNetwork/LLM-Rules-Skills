import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { withDiagnosticArtifacts } from "../testkit/diagnostics.js";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";

describe("withDiagnosticArtifacts", () => {
  let fixture: ProjectFixture | undefined;
  const cleanupRoots: string[] = [];

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
    for (const root of cleanupRoots.splice(0)) {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("does not write diagnostics when the body succeeds", async () => {
    fixture = await createProjectFixture();
    const resultsRoot = path.join(fixture.root, "diag-out");
    cleanupRoots.push(resultsRoot);

    await withDiagnosticArtifacts(
      { testName: "success case", fixture, resultsRoot },
      async () => {
        await fixture!.write(".agent-harness/runs/demo/state.json", '{"ok":true}\n');
      },
    );

    await expect(access(resultsRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies harness state and writes a manifest when the body fails", async () => {
    fixture = await createProjectFixture();
    await fixture.initGit();
    await fixture.write(".agent-harness/runs/demo/state.json", '{"phase":"blocked"}\n');
    await fixture.write(".agent-harness/runs/demo/events.jsonl", '{"type":"run.started"}\n');
    const resultsRoot = path.join(fixture.root, "diag-out");
    cleanupRoots.push(resultsRoot);

    await expect(
      withDiagnosticArtifacts(
        { testName: "phase5 diagnostics sample", fixture, resultsRoot },
        async (diagnostics) => {
          diagnostics.noteServerError("POST /api/runs failed: boom");
          diagnostics.setRetryCount(1);
          throw new Error("intentional failure");
        },
      ),
    ).rejects.toThrow("intentional failure");

    const { readdir } = await import("node:fs/promises");
    const bundles = await readdir(resultsRoot);
    expect(bundles).toHaveLength(1);
    const bundle = path.join(resultsRoot, bundles[0]!);
    const manifest = JSON.parse(await readFile(path.join(bundle, "manifest.json"), "utf8")) as {
      testName: string;
      fixturePath: string;
      artifactPaths: string[];
      serverErrors: string[];
      retryCount: number;
      git: { status?: string; log?: string };
      error: { message: string };
    };
    expect(manifest.testName).toBe("phase5 diagnostics sample");
    expect(manifest.fixturePath).toBe(fixture.root);
    expect(manifest.artifactPaths).toContain(".agent-harness/");
    expect(manifest.serverErrors).toEqual(["POST /api/runs failed: boom"]);
    expect(manifest.retryCount).toBe(1);
    expect(manifest.error.message).toBe("intentional failure");
    expect(manifest.git.log).toMatch(/initial/);
    expect(await readFile(path.join(bundle, ".agent-harness", "runs", "demo", "state.json"), "utf8")).toContain(
      "blocked",
    );
  });
});

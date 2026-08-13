import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  freezeRunComponents,
  loadFrozenComponentManifest,
  resolveFrozenGuidanceRoot} from "../../src/application/component-freeze.js";
import { resolveHarnessHome, resolveProjectPaths } from "../../src/application/harness-home.js";
import { HarnessConfigSchema } from "../../src/config/schema.js";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("freezeRunComponents", () => {
  it("snapshots guidance into the run directory and ignores later source edits", async () => {
    const homeRoot = await mkdtemp(path.join(os.tmpdir(), "ah-freeze-home-"));
    tempRoots.push(homeRoot);
    const controlRoot = await mkdtemp(path.join(os.tmpdir(), "ah-freeze-repo-"));
    tempRoots.push(controlRoot);

    const home = resolveHarnessHome({ homeRoot });
    const project = resolveProjectPaths({
      projectKey: "proj1",
      controlRoot,
      home});
    await mkdir(path.join(home.sharedGuidanceRoot, "General"), { recursive: true });
    await writeFile(
      path.join(home.sharedGuidanceRoot, "General", "RULE.md"),
      "original guidance\n",
      "utf8",
    );
    await mkdir(project.runsRoot, { recursive: true });

    const config = HarnessConfigSchema.parse({
      repositoryRoot: controlRoot,
      stateDirectory: project.projectStateRoot});

    const manifest = await freezeRunComponents({
      runId: "run-1",
      runsRoot: project.runsRoot,
      project,
      home,
      config});
    expect(manifest.components.some((item) => item.kind === "guidance-tree")).toBe(true);

    await writeFile(
      path.join(home.sharedGuidanceRoot, "General", "RULE.md"),
      "mutated after freeze\n",
      "utf8",
    );

    const frozen = await readFile(
      path.join(project.runsRoot, "run-1", "frozen-components", "guidance", "General", "RULE.md"),
      "utf8",
    );
    expect(frozen).toBe("original guidance\n");

    const loaded = await loadFrozenComponentManifest(project.runsRoot, "run-1");
    expect(loaded?.components[0]?.sha256).toBe(manifest.components[0]?.sha256);

    const frozenRoot = await resolveFrozenGuidanceRoot(project.runsRoot, "run-1");
    expect(frozenRoot?.path).toBe(
      path.join(project.runsRoot, "run-1", "frozen-components", "guidance"),
    );
    expect(frozenRoot?.sha256).toBe(manifest.components[0]?.sha256);
  });
});

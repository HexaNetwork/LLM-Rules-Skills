import { describe, expect, it } from "vitest";
import { GitService } from "../../src/git.js";
import { createProjectFixture, fixtureConfig } from "../helpers.js";

describe("repository intelligence generated artifacts", () => {
  it("installs shared excludes for GitNexus and CodeGraph indexes", async () => {
    const fixture = await createProjectFixture();
    await fixture.initGit();
    const config = fixtureConfig(fixture.root, {
      git: { ...fixtureConfig(fixture.root).git, enabled: true },
    });

    await new GitService(config).ensureRepositoryIntelligenceArtifactsIgnored();

    await expect(
      fixture.git("check-ignore", "--no-index", ".gitnexus/gitnexus.json"),
    ).resolves.toContain(".gitnexus/gitnexus.json");
    await expect(
      fixture.git("check-ignore", "--no-index", ".codegraph/codegraph.db"),
    ).resolves.toContain(".codegraph/codegraph.db");
  });

  it("refuses tracked provider indexes", async () => {
    const fixture = await createProjectFixture({
      initialFiles: {
        "README.md": "# Fixture\n",
        ".gitnexus/gitnexus.json": "{}\n",
      },
    });
    await fixture.initGit();
    const config = fixtureConfig(fixture.root, {
      git: { ...fixtureConfig(fixture.root).git, enabled: true },
    });

    await expect(
      new GitService(config).ensureRepositoryIntelligenceArtifactsIgnored(),
    ).rejects.toThrow(/tracked index files/i);
  });
});

import path from "node:path";
import { access } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProjectFixture,
  fixtureTempPrefix,
  type ProjectFixture,
} from "../testkit/project-fixture.js";

describe("createProjectFixture", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = undefined;
    }
  });

  it("creates a disposable project under the fixture temp prefix", async () => {
    fixture = await createProjectFixture({
      initialFiles: {
        "README.md": "# Custom\n",
        "src/hello.ts": "export const hello = 1;\n",
      },
    });

    expect(path.resolve(fixture.root).toLowerCase()).toContain(
      path.basename(fixtureTempPrefix()).toLowerCase(),
    );
    expect(await fixture.read("README.md")).toContain("Custom");
    expect(await fixture.read("src/hello.ts")).toContain("hello");
    expect(fixture.config.repositoryRoot).toBe(fixture.root);
  });

  it("initGit configures identity, ignores harness state, and normalizes the branch", async () => {
    fixture = await createProjectFixture();
    await fixture.initGit({ branch: "main" });

    expect((await fixture.git("branch", "--show-current")).trim()).toBe("main");
    expect(await fixture.read(".gitignore")).toContain(".agent-harness/");
    expect((await fixture.git("config", "--get", "user.email")).trim()).toBe(
      "harness@example.com",
    );
    expect((await fixture.git("log", "-1", "--format=%s")).trim()).toBe("initial");
  });

  it("cleanup removes the fixture and refuses paths outside the temp prefix", async () => {
    fixture = await createProjectFixture();
    const root = fixture.root;
    await fixture.cleanup();
    fixture = undefined;

    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });

    const rogue = await createProjectFixture();
    const unsafe = {
      ...rogue,
      root: path.resolve(rogue.root, "..", "not-a-fixture"),
    };
    await expect(unsafe.cleanup()).rejects.toThrow(/Refusing to cleanup/);
    await rogue.cleanup();
  });
});

import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeShellWrappers } from "../../src/domain/shell-wrappers.js";
import { classifyFailure } from "../../src/plugins/commands.js";

const tempDirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-wrappers-"));
  tempDirs.push(dir);
  return dir;
}

describe("normalizeShellWrappers", () => {
  it("rewrites CRLF shebang wrappers to LF", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "gradlew"), "#!/bin/sh\r\n\r\necho hi\r\n", "utf8");
    await writeFile(path.join(root, "mvnw"), "#!/bin/sh\r\nexec java\r\n", "utf8");

    const fixed = await normalizeShellWrappers(root);

    expect(fixed.sort()).toEqual(["gradlew", "mvnw"]);
    expect(await readFile(path.join(root, "gradlew"), "utf8")).toBe("#!/bin/sh\n\necho hi\n");
    expect(await readFile(path.join(root, "mvnw"), "utf8")).toBe("#!/bin/sh\nexec java\n");
  });

  it("leaves LF wrappers and non-shebang files alone", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "gradlew"), "#!/bin/sh\necho hi\n", "utf8");
    await writeFile(path.join(root, "README"), "hello\r\n", "utf8");
    await mkdir(path.join(root, "nested"), { recursive: true });
    await writeFile(path.join(root, "nested", "gradlew"), "#!/bin/sh\r\nok\r\n", "utf8");

    const fixed = await normalizeShellWrappers(root);

    expect(fixed).toEqual([]);
    expect(await readFile(path.join(root, "gradlew"), "utf8")).toBe("#!/bin/sh\necho hi\n");
    expect(await readFile(path.join(root, "README"), "utf8")).toBe("hello\r\n");
    expect(await readFile(path.join(root, "nested", "gradlew"), "utf8")).toBe("#!/bin/sh\r\nok\r\n");
  });

  it("ignores missing wrappers", async () => {
    const root = await tempRoot();
    await expect(normalizeShellWrappers(root)).resolves.toEqual([]);
  });
});

describe("classifyFailure", () => {
  it("treats dash-style script not-found as environment failure", () => {
    expect(classifyFailure("sh: 1: ./gradlew: not found")).toBe("environment_failure");
    expect(classifyFailure("bash: ./mvnw: bad interpreter: /bin/sh^M: no such file or directory")).toBe(
      "environment_failure",
    );
  });

  it("keeps ordinary test failures as project failures", () => {
    expect(classifyFailure("AssertionError: expected true")).toBe("project_failure");
    expect(classifyFailure("BUILD FAILED")).toBe("project_failure");
  });
});

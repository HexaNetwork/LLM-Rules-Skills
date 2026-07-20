import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadDotEnvFiles, parseDotEnv } from "../../src/util/dotenv.js";

describe("parseDotEnv", () => {
  it("parses keys, quotes, comments, and blanks", () => {
    const parsed = parseDotEnv(`
# comment
GITHUB_TOKEN=ghp_abc
CURSOR_API_KEY="key with spaces"
EMPTY=
'SKIP'=no
BAD KEY=x
SINGLE='quoted'
`);
    expect(parsed).toEqual({
      GITHUB_TOKEN: "ghp_abc",
      CURSOR_API_KEY: "key with spaces",
      EMPTY: "",
      SINGLE: "quoted",
    });
  });
});

describe("loadDotEnvFiles", () => {
  it("lets .env.local override .env but not shell env", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-harness-dotenv-"));
    await writeFile(
      path.join(dir, ".env"),
      "FROM_ENV=base\nSHARED=from-env\nSHELL_WINS=from-env\n",
      "utf8",
    );
    await writeFile(
      path.join(dir, ".env.local"),
      "SHARED=from-local\nLOCAL_ONLY=1\n",
      "utf8",
    );

    const env: NodeJS.ProcessEnv = { SHELL_WINS: "from-shell" };
    const loaded = await loadDotEnvFiles(dir, env);

    expect(loaded).toHaveLength(2);
    expect(env.FROM_ENV).toBe("base");
    expect(env.SHARED).toBe("from-local");
    expect(env.LOCAL_ONLY).toBe("1");
    expect(env.SHELL_WINS).toBe("from-shell");
  });

  it("ignores missing files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-harness-dotenv-"));
    const env: NodeJS.ProcessEnv = {};
    const loaded = await loadDotEnvFiles(dir, env);
    expect(loaded).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { redactEnv } from "../../src/plugins/dashboard.js";

describe("redactEnv", () => {
  it("redacts CURSOR_API_KEY and other KEY|TOKEN|SECRET names", () => {
    expect(
      redactEnv([
        "CURSOR_API_KEY=secret",
        "GITHUB_TOKEN=ghs_xxx",
        "my_SeCrEt=value",
        "PATH=/usr/bin",
        "HOME=/home/op",
      ]),
    ).toEqual([
      "CURSOR_API_KEY=<redacted>",
      "GITHUB_TOKEN=<redacted>",
      "my_SeCrEt=<redacted>",
      "PATH=/usr/bin",
      "HOME=/home/op",
    ]);
  });

  it("treats entries without = as bare names", () => {
    expect(redactEnv(["PATH", "API_KEY", "plain"])).toEqual([
      "PATH",
      "API_KEY=<redacted>",
      "plain",
    ]);
  });
});

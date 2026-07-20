import { describe, expect, it } from "vitest";
import { topologicalSort, allDependents } from "../../src/engine/dag.js";
import type { ManifestTask } from "../../src/schemas/manifest.js";

function task(
  id: string,
  blockedBy: string[] = [],
): ManifestTask {
  return {
    id,
    title: id,
    mode: "AFK",
    body: "",
    acceptanceCriteria: [{ id: "ac-1", text: "Do the thing correctly" }],
    blockedBy,
    allowedGlobs: ["**/*"],
    testSeams: [],
    browserProbes: [],
  };
}

describe("topologicalSort", () => {
  it("returns stable order for independent tasks", () => {
    const result = topologicalSort([task("b"), task("a")]);
    expect(result).toEqual({ ok: true, order: ["a", "b"] });
  });

  it("orders dependencies first", () => {
    const result = topologicalSort([
      task("c", ["b"]),
      task("b", ["a"]),
      task("a"),
    ]);
    expect(result).toEqual({ ok: true, order: ["a", "b", "c"] });
  });

  it("detects cycles", () => {
    const result = topologicalSort([task("a", ["b"]), task("b", ["a"])]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.cycle?.sort()).toEqual(["a", "b"]);
    }
  });

  it("rejects missing dependencies", () => {
    const result = topologicalSort([task("a", ["missing"])]);
    expect(result.ok).toBe(false);
  });
});

describe("allDependents", () => {
  it("walks transitive dependents", () => {
    const tasks = [task("a"), task("b", ["a"]), task("c", ["b"]), task("d")];
    expect(allDependents(tasks, "a").sort()).toEqual(["b", "c"]);
  });
});

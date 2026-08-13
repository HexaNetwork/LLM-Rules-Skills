import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  CODEGRAPH_INDEX_DB,
  CodeGraphAdapter,
} from "../../src/infrastructure/repository-intelligence/adapters/codegraph-adapter.js";
import type { ExecutableRunner } from "../../src/infrastructure/repository-intelligence/types.js";
import { fixtureRoot } from "../helpers.js";
import {
  describeAdapterContract,
  writeCodegraphIndex,
} from "./repository-intelligence-adapter-contract.js";

describeAdapterContract({
  providerId: "codegraph",
  command: "codegraph",
  create(root, runner, options = {}) {
    return new CodeGraphAdapter(
      { workspaceRoot: root },
      {
        enabled: options.enabled ?? true,
        command: "codegraph",
        updateTimeoutMs: 60_000,
        queryTimeoutMs: 5_000,
        maxFiles: 8,
        stopwords: [],
        sourceExtensions: [".ts"],
        maxCharacters: options.maxCharacters ?? 3_000,
      },
      runner,
    );
  },
  writeIndex: writeCodegraphIndex,
  isQueryCall: (args) => args[0] === "explore" || args[0] === "node",
  refreshArgs: (root) => ["sync", root],
});

describe("CodeGraphAdapter", () => {
  it("preserves exact-symbol query shaping and bounded output", async () => {
    const root = await fixtureRoot();
    const index = path.join(root, ...CODEGRAPH_INDEX_DB.split("/"));
    await mkdir(path.dirname(index), { recursive: true });
    await writeFile(index, "index\n", "utf8");
    const runner = vi.fn<ExecutableRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: "SettlementWindow -> Ledger\n".repeat(20),
      stderr: "",
      timedOut: false,
    });
    const adapter = new CodeGraphAdapter({ workspaceRoot: root }, {
      enabled: true,
      command: "codegraph",
      updateTimeoutMs: 60_000,
      queryTimeoutMs: 5_000,
      maxFiles: 8,
      stopwords: [],
      sourceExtensions: [".ts"],
      maxCharacters: 80,
    }, runner);

    const result = await adapter.retrieve({
      capability: "search",
      query: "generic prose",
      pathHints: ["src/billing/SettlementWindow.ts"],
    });

    expect(runner).toHaveBeenCalledWith(
      "codegraph",
      ["node", "SettlementWindow", "-p", root],
      expect.objectContaining({ cwd: root }),
    );
    expect(result.artifact).toMatchObject({
      providerId: "codegraph",
      source: "repository:codegraph",
    });
    expect(result.artifact!.excerpt.length).toBeLessThanOrEqual(80);
  });

  it("inits when prepare finds a missing index", async () => {
    const root = await fixtureRoot();
    const index = path.join(root, ...CODEGRAPH_INDEX_DB.split("/"));
    const runner = vi.fn<ExecutableRunner>(async (_command, args) => {
      if (args[0] === "--version") {
        return { exitCode: 0, stdout: "1.5.0\n", stderr: "", timedOut: false };
      }
      if (args[0] === "init") {
        await mkdir(path.dirname(index), { recursive: true });
        await writeFile(index, "index\n", "utf8");
        return { exitCode: 0, stdout: "Indexed\n", stderr: "", timedOut: false };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected", timedOut: false };
    });
    const adapter = new CodeGraphAdapter({ workspaceRoot: root }, {
      enabled: true,
      command: "codegraph",
      updateTimeoutMs: 60_000,
      queryTimeoutMs: 5_000,
      maxFiles: 8,
      stopwords: [],
      sourceExtensions: [".ts"],
      maxCharacters: 3_000,
    }, runner);

    await expect(adapter.prepare()).resolves.toMatchObject({
      available: true,
      indexReady: true,
      refreshed: true,
    });
    expect(runner).toHaveBeenCalledWith(
      "codegraph",
      ["init", root],
      expect.objectContaining({ cwd: root }),
    );
  });
});

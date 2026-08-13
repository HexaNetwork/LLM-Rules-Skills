import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  GITNEXUS_INDEX_METADATA,
  GitNexusAdapter,
} from "../../src/infrastructure/repository-intelligence/adapters/gitnexus-adapter.js";
import type { ExecutableRunner } from "../../src/infrastructure/repository-intelligence/types.js";
import { fixtureRoot } from "../helpers.js";
import {
  describeAdapterContract,
  writeGitNexusIndex,
} from "./repository-intelligence-adapter-contract.js";

describeAdapterContract({
  providerId: "gitnexus",
  command: "gitnexus",
  create(root, runner, options = {}) {
    return new GitNexusAdapter(
      { workspaceRoot: root },
      {
        enabled: options.enabled ?? true,
        command: "gitnexus",
        updateTimeoutMs: 60_000,
        queryTimeoutMs: 5_000,
        maxResults: 5,
        stopwords: [],
        sourceExtensions: [".ts"],
        maxCharacters: options.maxCharacters ?? 3_000,
      },
      runner,
    );
  },
  writeIndex: writeGitNexusIndex,
  isQueryCall: (args) => args[0] === "query" || args[0] === "context",
  refreshArgs: (root) => [
    "analyze",
    root,
    "--index-only",
    "--skip-agents-md",
    "--skip-skills",
  ],
});

describe("GitNexusAdapter command shape", () => {
  it("analyzes in index-only mode and queries by absolute workspace identity", async () => {
    const root = await fixtureRoot();
    const metadata = path.join(root, ...GITNEXUS_INDEX_METADATA.split("/"));
    const calls: string[][] = [];
    const runner = vi.fn<ExecutableRunner>(async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "analyze") {
        await mkdir(path.dirname(metadata), { recursive: true });
        await writeFile(metadata, "{}\n", "utf8");
      }
      return {
        exitCode: 0,
        stdout: args[0] === "query" ? "SettlementWindow -> Ledger\n" : "ok\n",
        stderr: "",
        timedOut: false,
      };
    });
    const adapter = new GitNexusAdapter({ workspaceRoot: root }, settings(), runner);

    await expect(adapter.prepare()).resolves.toMatchObject({
      available: true,
      indexReady: true,
      refreshed: true,
    });
    const result = await adapter.retrieve({
      capability: "search",
      query: "SettlementWindow ledger",
    });

    expect(calls).toContainEqual([
      "analyze",
      root,
      "--index-only",
      "--skip-agents-md",
      "--skip-skills",
    ]);
    expect(calls).toContainEqual([
      "query",
      "SettlementWindow ledger",
      "--repo",
      root,
      "--limit",
      "5",
      "--content",
    ]);
    expect(result.artifact).toMatchObject({
      providerId: "gitnexus",
      source: "repository:gitnexus",
      metadata: { workspaceIdentity: root },
    });
  });

  it("uses context with the exact worktree path for source hints", async () => {
    const root = await fixtureRoot();
    await writeGitNexusIndex(root);
    const runner = vi.fn<ExecutableRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: "SettlementWindow callers\n",
      stderr: "",
      timedOut: false,
    });
    const adapter = new GitNexusAdapter({ workspaceRoot: root }, settings(), runner);

    await adapter.retrieve({
      capability: "search",
      query: "generic prose",
      pathHints: ["src/billing/SettlementWindow.ts"],
    });

    expect(runner).toHaveBeenCalledWith(
      "gitnexus",
      ["context", "SettlementWindow", "--repo", root, "--content"],
      expect.objectContaining({ cwd: root }),
    );
  });

  it("never uses a basename/registry alias for --repo", async () => {
    const root = await fixtureRoot();
    await writeGitNexusIndex(root);
    const runner = vi.fn<ExecutableRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: "hit\n",
      stderr: "",
      timedOut: false,
    });
    const adapter = new GitNexusAdapter({ workspaceRoot: root }, settings(), runner);

    await adapter.retrieve({
      capability: "search",
      query: "SettlementWindow ledger",
    });

    const queryCall = runner.mock.calls.find(([, args]) => args[0] === "query");
    expect(queryCall?.[1]).toContain(root);
    expect(queryCall?.[1]).not.toContain(path.basename(root));
  });
});

function settings() {
  return {
    enabled: true,
    command: "gitnexus",
    updateTimeoutMs: 60_000,
    queryTimeoutMs: 5_000,
    maxResults: 5,
    stopwords: [],
    sourceExtensions: [".ts"],
    maxCharacters: 3_000,
  };
}

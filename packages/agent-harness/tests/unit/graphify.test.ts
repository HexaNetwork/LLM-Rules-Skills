import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  GraphifyRepositoryLookup,
  buildGraphifyQuery,
  prepareGraphifyForRun,
  type GraphifyCommandResult,
  type GraphifyRunner,
} from "../../src/graphify.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

describe("buildGraphifyQuery", () => {
  it("keeps identifiers and drops boilerplate stopwords", () => {
    const query = buildGraphifyQuery(
      "I want to change the BuildableCapitol implementation tests architecture acceptance security standards public interface seam",
    );
    expect(query).toContain("BuildableCapitol");
    expect(query.toLowerCase()).not.toContain("change");
    expect(query.toLowerCase()).not.toContain("implementation");
    expect(query.toLowerCase()).not.toContain("architecture");
    expect(query.split(/\s+/).length).toBeLessThanOrEqual(12);
  });
});

describe("GraphifyRepositoryLookup", () => {
  it("runs the project-local setup only when a new run lacks a usable graph", async () => {
    const root = await fixtureRoot();
    const graphPath = path.join(root, "graphify-out", "graph.json");
    const scriptPath = path.join(
      root,
      "agent-harness",
      "scripts",
      process.platform === "win32" ? "setup-graphify.ps1" : "setup-graphify.sh",
    );
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, "# setup\n", "utf8");
    const runner = vi.fn<GraphifyRunner>().mockResolvedValue(result("graphify 0.9.1\n"));
    const setup = vi.fn(async () => {
      await mkdir(path.dirname(graphPath), { recursive: true });
      await writeFile(graphPath, "{}\n", "utf8");
      return result("ready\n");
    });
    const config = fixtureConfig(root, {
      knowledge: {
        ...fixtureConfig(root).knowledge,
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: true },
      },
    });

    await expect(prepareGraphifyForRun(config, runner, setup)).resolves.toMatchObject({
      enabled: true,
      graphReady: true,
      setupRan: true,
    });
    expect(setup).toHaveBeenCalledOnce();

    await expect(prepareGraphifyForRun(config, runner, setup)).resolves.toMatchObject({
      setupRan: false,
    });
    expect(setup).toHaveBeenCalledOnce();
  });

  it("updates and queries the repository graph with argument-safe process calls", async () => {
    const root = await fixtureRoot();
    const graphPath = path.join(root, "graphify-out", "graph.json");
    await mkdir(path.dirname(graphPath), { recursive: true });
    await writeFile(graphPath, "{}\n", "utf8");
    const calls: Array<{ executable: string; args: string[]; timeoutMs: number }> = [];
    const runner: GraphifyRunner = async (executable, args, options) => {
      calls.push({ executable, args, timeoutMs: options.timeoutMs });
      return result(
        args[0] === "query"
          ? "NODE LocalKnowledgeBase [src=packages/agent-harness/src/knowledge.ts loc=L47]\n"
          : "Updated graph\n",
      );
    };
    const config = fixtureConfig(root, {
      knowledge: {
        sources: ["README.md", "docs"],
        chunkCharacters: 400,
        graphify: {
          enabled: true,
          command: "graphify-custom",
          updateOnRefresh: true,
          updateTimeoutMs: 90_000,
          queryTimeoutMs: 7_000,
          queryBudgetTokens: 900,
          roles: ["implementer"],
        },
      },
    });
    const lookup = new GraphifyRepositoryLookup(config, runner);

    await lookup.refresh();
    const found = await lookup.search("Where is knowledge loaded?");

    expect(calls[0]).toEqual({
      executable: "graphify-custom",
      args: ["update", root],
      timeoutMs: 90_000,
    });
    expect(calls[1]).toEqual({
      executable: "graphify-custom",
      args: [
        "query",
        "knowledge loaded",
        "--budget",
        "900",
        "--graph",
        graphPath,
      ],
      timeoutMs: 7_000,
    });
    expect(found).toMatchObject({
      source: "graphify:graphify-out/graph.json",
      title: "Repository relationships (Graphify)",
    });
    expect(found?.excerpt).toContain("LocalKnowledgeBase");
  });

  it("returns no context when Graphify finds no matching nodes", async () => {
    const root = await fixtureRoot();
    const graphPath = path.join(root, "graphify-out", "graph.json");
    await mkdir(path.dirname(graphPath), { recursive: true });
    await writeFile(graphPath, "{}\n", "utf8");
    const runner = vi.fn<GraphifyRunner>().mockResolvedValue(result("No matching nodes found.\n"));
    const config = fixtureConfig(root, {
      knowledge: {
        sources: ["README.md", "docs"],
        chunkCharacters: 400,
        graphify: {
          ...fixtureConfig(root).knowledge.graphify,
          enabled: true,
        },
      },
    });

    await expect(new GraphifyRepositoryLookup(config, runner).search("unknown")).resolves.toBeUndefined();
  });
});

function result(stdout: string): GraphifyCommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

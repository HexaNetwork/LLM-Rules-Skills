import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  ExecutableRunner,
  RepositoryIntelligenceAdapter,
} from "../../src/infrastructure/repository-intelligence/types.js";
import { fixtureRoot } from "../helpers.js";

export type AdapterContractDriver = {
  providerId: string;
  command: string;
  create(
    root: string,
    runner: ExecutableRunner,
    options?: { enabled?: boolean; maxCharacters?: number },
  ): RepositoryIntelligenceAdapter;
  writeIndex(root: string): Promise<void>;
  /** True when the runner args are a retrieval/query invocation. */
  isQueryCall(args: readonly string[]): boolean;
  /** Args used to refresh when an index already exists. */
  refreshArgs(root: string): string[];
};

/**
 * Shared adapter contract: readiness, refresh, miss/failure normalization,
 * output budgets, and path safety. Broker-level cache/fallback lives elsewhere.
 */
export function describeAdapterContract(driver: AdapterContractDriver): void {
  describe(`${driver.providerId} adapter contract`, () => {
    it("reports disabled readiness without invoking the executable", async () => {
      const root = await fixtureRoot();
      const runner = vi.fn<ExecutableRunner>();
      const adapter = driver.create(root, runner, { enabled: false });

      await expect(adapter.readiness()).resolves.toMatchObject({
        available: false,
        indexReady: false,
        generation: "disabled",
        detail: "disabled",
      });
      expect(runner).not.toHaveBeenCalled();
    });

    it("reports readiness when the command and index are present", async () => {
      const root = await fixtureRoot();
      await driver.writeIndex(root);
      const runner = vi.fn<ExecutableRunner>().mockResolvedValue({
        exitCode: 0,
        stdout: "1.0.0\n",
        stderr: "",
        timedOut: false,
      });
      const adapter = driver.create(root, runner);

      await expect(adapter.readiness()).resolves.toMatchObject({
        available: true,
        indexReady: true,
      });
      expect(runner).toHaveBeenCalledWith(
        driver.command,
        ["--version"],
        expect.objectContaining({ cwd: root }),
      );
    });

    it("reports command-unavailable when --version fails", async () => {
      const root = await fixtureRoot();
      await driver.writeIndex(root);
      const runner = vi.fn<ExecutableRunner>().mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "not found",
        timedOut: false,
      });
      const adapter = driver.create(root, runner);

      await expect(adapter.readiness()).resolves.toMatchObject({
        available: false,
        detail: "command-unavailable",
      });
    });

    it("reports index-missing when the command works but no index exists", async () => {
      const root = await fixtureRoot();
      const runner = vi.fn<ExecutableRunner>().mockResolvedValue({
        exitCode: 0,
        stdout: "1.0.0\n",
        stderr: "",
        timedOut: false,
      });
      const adapter = driver.create(root, runner);

      await expect(adapter.readiness()).resolves.toMatchObject({
        available: true,
        indexReady: false,
        detail: "index-missing",
      });
    });

    it("refreshes an existing index with the provider-specific command shape", async () => {
      const root = await fixtureRoot();
      await driver.writeIndex(root);
      const calls: string[][] = [];
      const runner = vi.fn<ExecutableRunner>(async (_command, args) => {
        calls.push([...args]);
        return { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false };
      });
      const adapter = driver.create(root, runner);

      await expect(adapter.refresh()).resolves.toMatchObject({
        available: true,
        indexReady: true,
        refreshed: true,
      });
      expect(calls).toContainEqual(driver.refreshArgs(root));
    });

    it("normalizes empty stdout as a miss", async () => {
      const root = await fixtureRoot();
      await driver.writeIndex(root);
      const runner = vi.fn<ExecutableRunner>(async (_command, args) => {
        if (args[0] === "--version") {
          return { exitCode: 0, stdout: "1.0.0\n", stderr: "", timedOut: false };
        }
        return { exitCode: 0, stdout: "\n", stderr: "", timedOut: false };
      });
      const adapter = driver.create(root, runner);

      const result = await adapter.retrieve({
        capability: "search",
        query: "SettlementWindow ledger",
      });
      expect(result.artifact).toBeUndefined();
      expect(result.skippedReason).toBe("no-matches");
      expect(result.shapedQuery.length).toBeGreaterThan(0);
    });

    it("normalizes non-zero exit as query-failed", async () => {
      const root = await fixtureRoot();
      await driver.writeIndex(root);
      const runner = vi.fn<ExecutableRunner>(async (_command, args) => {
        if (args[0] === "--version") {
          return { exitCode: 0, stdout: "1.0.0\n", stderr: "", timedOut: false };
        }
        return { exitCode: 1, stdout: "", stderr: "boom", timedOut: false };
      });
      const adapter = driver.create(root, runner);

      const result = await adapter.retrieve({
        capability: "search",
        query: "SettlementWindow ledger",
      });
      expect(result.artifact).toBeUndefined();
      expect(result.skippedReason).toBe("query-failed");
    });

    it("normalizes timeouts as query-timeout", async () => {
      const root = await fixtureRoot();
      await driver.writeIndex(root);
      const runner = vi.fn<ExecutableRunner>(async (_command, args) => {
        if (args[0] === "--version") {
          return { exitCode: 0, stdout: "1.0.0\n", stderr: "", timedOut: false };
        }
        return { exitCode: 1, stdout: "", stderr: "", timedOut: true };
      });
      const adapter = driver.create(root, runner);

      const result = await adapter.retrieve({
        capability: "search",
        query: "SettlementWindow ledger",
      });
      expect(result.artifact).toBeUndefined();
      expect(result.skippedReason).toBe("query-timeout");
    });

    it("skips generic queries without calling the provider", async () => {
      const root = await fixtureRoot();
      await driver.writeIndex(root);
      const runner = vi.fn<ExecutableRunner>().mockResolvedValue({
        exitCode: 0,
        stdout: "1.0.0\n",
        stderr: "",
        timedOut: false,
      });
      const adapter = driver.create(root, runner);

      const result = await adapter.retrieve({
        capability: "search",
        query: "the objective acceptance criteria",
        fallbackQuery: "recommendation ticket grill packet",
      });
      expect(result.artifact).toBeUndefined();
      expect(result.skippedReason).toBe("generic-query");
      expect(runner.mock.calls.every(([, args]) => !driver.isQueryCall(args))).toBe(true);
    });

    it("bounds retrieval excerpts to the character budget", async () => {
      const root = await fixtureRoot();
      await driver.writeIndex(root);
      const runner = vi.fn<ExecutableRunner>(async (_command, args) => {
        if (args[0] === "--version") {
          return { exitCode: 0, stdout: "1.0.0\n", stderr: "", timedOut: false };
        }
        return {
          exitCode: 0,
          stdout: "SettlementWindow -> Ledger\n".repeat(40),
          stderr: "",
          timedOut: false,
        };
      });
      const adapter = driver.create(root, runner, { maxCharacters: 64 });

      const result = await adapter.retrieve({
        capability: "search",
        query: "SettlementWindow ledger",
        maxCharacters: 64,
      });
      expect(result.artifact?.excerpt.length).toBeLessThanOrEqual(64);
      expect(result.artifact?.providerId).toBe(driver.providerId);
      expect(result.artifact?.source).toBe(`repository:${driver.providerId}`);
    });

    it("marks only configured source extensions as relevant paths", async () => {
      const root = await fixtureRoot();
      const adapter = driver.create(root, vi.fn());
      expect(adapter.isRelevantPath("src/settlement.ts")).toBe(true);
      expect(adapter.isRelevantPath(path.join("docs", "readme.md"))).toBe(false);
    });
  });
}

export async function writeCodegraphIndex(root: string): Promise<void> {
  const index = path.join(root, ".codegraph", "codegraph.db");
  await mkdir(path.dirname(index), { recursive: true });
  await writeFile(index, "index\n", "utf8");
}

export async function writeGitNexusIndex(root: string): Promise<void> {
  const metadata = path.join(root, ".gitnexus", "gitnexus.json");
  await mkdir(path.dirname(metadata), { recursive: true });
  await writeFile(metadata, "{}\n", "utf8");
}

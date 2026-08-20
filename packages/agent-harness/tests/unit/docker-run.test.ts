import { describe, expect, it } from "vitest";
import { buildDockerRunArgs, WORKER_DNS_SERVERS } from "../../src/domain/docker-run.js";
import { buildRunSpec } from "../../src/domain/mount-policy.js";

describe("buildDockerRunArgs", () => {
  it("pins public DNS resolvers for Cursor API reachability", () => {
    const spec = buildRunSpec({
      runId: "11111111-2222-4333-8444-555555555555",
      image: "agent-harness-worker:local",
      worktreeHost: "D:/data/worktree",
      cursorApiKey: "key",
    });
    const args = buildDockerRunArgs(spec);
    expect(args).toContain("--dns");
    for (const dns of WORKER_DNS_SERVERS) {
      expect(args).toContain(dns);
    }
    expect(args.indexOf("--dns")).toBeLessThan(args.indexOf(spec.image));
    expect(args).toContain("--read-only");
    expect(args).toContain(`${spec.worktreeHost}:/workspace`);
  });
});

import { describe, expect, it } from "vitest";
import {
  decideDockerCleanup,
  decideWorkspaceCleanup,
  type DockerCleanupFacts,
} from "../../src/domain/workspace-cleanup.js";
import { decideOrphanAction, type ManagedContainerSummary } from "../../src/application/orphan-reconciler.js";
import { HARNESS_CONTAINER_LABEL_PREFIX } from "../../src/infrastructure/container/container-spec.js";
import { commitsImportedOrReachable } from "../../src/application/execution-diagnostics.js";
import type { BundleImportState } from "../../src/domain/run-execution.js";

function dockerFacts(overrides: Partial<DockerCleanupFacts> = {}): DockerCleanupFacts {
  return {
    phase: "completed",
    workspaceKind: "docker-clone",
    alreadyRemoved: false,
    workerStopped: true,
    activeRpc: false,
    dirtyUnexportedTree: false,
    commitsImportedOrReachable: true,
    discard: false,
    ...overrides,
  };
}

describe("decideDockerCleanup", () => {
  it("allows volume removal when settled, stopped, clean, and imported", () => {
    expect(decideDockerCleanup(dockerFacts())).toEqual({
      allow: true,
      reason: "published-complete",
      removeVolume: true,
    });
  });

  it("requires discard for unpublished Docker work", () => {
    expect(
      decideDockerCleanup(
        dockerFacts({
          commitsImportedOrReachable: false,
          discard: false,
        }),
      ),
    ).toEqual({ allow: false, reason: "unpublished-requires-discard" });

    expect(
      decideDockerCleanup(
        dockerFacts({
          commitsImportedOrReachable: false,
          discard: true,
        }),
      ),
    ).toEqual({
      allow: true,
      reason: "discarded-unpublished",
      removeVolume: true,
    });
  });

  it("refuses running worker, active RPC, dirty unexported tree, and non-settled phases", () => {
    expect(decideDockerCleanup(dockerFacts({ workerStopped: false })).reason).toBe(
      "worker-still-running",
    );
    expect(decideDockerCleanup(dockerFacts({ activeRpc: true })).reason).toBe("active-rpc");
    expect(decideDockerCleanup(dockerFacts({ dirtyUnexportedTree: true })).reason).toBe(
      "dirty-unexported-tree",
    );
    expect(decideDockerCleanup(dockerFacts({ phase: "executing" })).reason).toBe("run-not-settled");
  });

  it("discriminates via decideWorkspaceCleanup", () => {
    const docker = decideWorkspaceCleanup({
      kind: "docker-clone",
      phase: "completed",
      alreadyRemoved: false,
      workerStopped: true,
      activeRpc: false,
      dirtyUnexportedTree: false,
      commitsImportedOrReachable: true,
      discard: false,
    });
    expect(docker.kind).toBe("docker-clone");
    expect(docker.allow).toBe(true);
  });
});

describe("orphan reconciler conservatism", () => {
  const labels = {
    [`${HARNESS_CONTAINER_LABEL_PREFIX}.managed`]: "true",
    [`${HARNESS_CONTAINER_LABEL_PREFIX}.run-id`]: "run-1",
  };

  function container(overrides: Partial<ManagedContainerSummary> = {}): ManagedContainerSummary {
    return {
      id: "c1",
      name: "ah-project-run-1",
      state: "exited",
      labels,
      image: "img",
      runId: "run-1",
      createdAt: new Date(0).toISOString(),
      ...overrides,
    };
  }

  it("keeps young unmatched containers", () => {
    const decision = decideOrphanAction(container({ createdAt: new Date().toISOString() }), {
      knownByRun: new Map(),
      knownByContainer: new Map(),
      now: new Date(),
      minAgeMs: 24 * 60 * 60 * 1000,
    });
    expect(decision).toEqual({ action: "keep", reason: "too-young" });
  });

  it("keeps running containers even when old", () => {
    const decision = decideOrphanAction(container({ state: "running" }), {
      knownByRun: new Map(),
      knownByContainer: new Map(),
      now: new Date("2030-01-01T00:00:00.000Z"),
      minAgeMs: 1000,
    });
    expect(decision).toEqual({ action: "keep", reason: "run-active" });
  });

  it("removes only stale exited containers with no matching run after age gate", () => {
    const decision = decideOrphanAction(container(), {
      knownByRun: new Map(),
      knownByContainer: new Map(),
      now: new Date("2030-01-01T00:00:00.000Z"),
      minAgeMs: 1000,
    });
    expect(decision).toEqual({ action: "remove-container", reason: "orphaned-stale-no-run" });
  });

  it("keeps matching active runs", () => {
    const decision = decideOrphanAction(container({ state: "running" }), {
      knownByRun: new Map([["run-1", { runId: "run-1", phase: "executing" }]]),
      knownByContainer: new Map(),
      now: new Date("2030-01-01T00:00:00.000Z"),
      minAgeMs: 1000,
    });
    expect(decision).toEqual({ action: "keep", reason: "run-active" });
  });
});

describe("commitsImportedOrReachable", () => {
  it("treats promoted and delivery refs as durable", () => {
    expect(
      commitsImportedOrReachable({
        version: 1,
        status: "promoted",
        updatedAt: new Date().toISOString(),
      } satisfies BundleImportState),
    ).toBe(true);
    expect(
      commitsImportedOrReachable({
        version: 1,
        status: "validated",
        deliveryBranch: "feature/x",
        updatedAt: new Date().toISOString(),
      }),
    ).toBe(true);
    expect(
      commitsImportedOrReachable({
        version: 1,
        status: "none",
        updatedAt: new Date().toISOString(),
      }),
    ).toBe(false);
  });
});

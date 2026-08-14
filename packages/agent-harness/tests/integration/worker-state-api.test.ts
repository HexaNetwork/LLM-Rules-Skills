import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import type { RunStateSnapshot } from "../../src/application/run-state-port.js";
import { createRunState, type RunState, type TransitionResult } from "../../src/domain.js";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import { RunStore } from "../../src/store.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { WORKER_STATE_AUDIT_LOG } from "../../src/ui/http/routes/worker-state.js";
import {
  RUN_STATE_API_AUTH_HEADER,
  RUN_STATE_API_PROTOCOL_HEADER,
  RUN_STATE_API_PROTOCOL_VERSION,
  runStateApiPath,
} from "../../src/worker/state-protocol.js";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";

const NOW = "2026-08-14T12:00:00.000Z";

/**
 * Worker-facing host state API over real HTTP (ADR 0016, plan Phase 3).
 * The server under test is the regular dashboard server; the state API is a
 * separate prefix with its own per-run credential and protocol version.
 */
describe("worker state API", () => {
  let fixture: ProjectFixture | undefined;
  let ui: UiServer | undefined;
  let store: RunStore;

  afterEach(async () => {
    await ui?.close();
    ui = undefined;
    await fixture?.cleanup();
    fixture = undefined;
  });

  async function setup(runIds: string[] = ["run-a"]) {
    fixture = await createProjectFixture();
    const stateRoot = resolveHarnessPaths(fixture.config).stateRoot;
    store = new RunStore(fixture.config, stateRoot);
    await store.initialize();
    for (const runId of runIds) {
      await store.create(createRunState(runId, `Idea for ${runId}`, NOW));
      await store.writeJson(runId, "config.json", fixture.config);
    }
    ui = await startUiServer({
      config: fixture.config,
      backend: createFakeBackend({}),
      port: 0,
      token: "ui-test",
    });
    return { stateRoot };
  }

  async function api(
    runId: string,
    operation: string,
    init: {
      method?: string;
      token?: string;
      protocol?: string;
      body?: unknown;
    } = {},
  ): Promise<Response> {
    if (!ui) throw new Error("server not started");
    return fetch(`${ui.origin}${runStateApiPath(runId, operation)}`, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: {
        ...(init.token !== undefined ? { [RUN_STATE_API_AUTH_HEADER]: init.token } : {}),
        ...(init.protocol !== undefined
          ? { [RUN_STATE_API_PROTOCOL_HEADER]: init.protocol }
          : { [RUN_STATE_API_PROTOCOL_HEADER]: String(RUN_STATE_API_PROTOCOL_VERSION) }),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  }

  async function ok<T>(response: Response): Promise<T> {
    const body = (await response.json()) as { ok: boolean; result: T; error?: unknown };
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    return body.result;
  }

  function transitionFrom(snapshot: RunStateSnapshot, change: Partial<RunState>): TransitionResult {
    return {
      state: { ...snapshot.state, ...change, updatedAt: NOW },
      events: [{ type: "reflect.drafted", at: NOW, detail: {} }],
    };
  }

  it("serves the worker bootstrap document with frozen config, workspace identity, and revision", async () => {
    await setup(["run-a"]);
    const { token } = await ui!.issueWorkerStateCredential("run-a", {
      workerInstanceId: "worker-1",
    });

    const result = await ok<{
      runId: string;
      protocolVersion: number;
      revision: number;
      workerInstanceId?: string;
      config: { repositoryRoot: string };
      workspace: Record<string, unknown>;
    }>(await api("run-a", "bootstrap", { token }));

    expect(result.runId).toBe("run-a");
    expect(result.protocolVersion).toBe(RUN_STATE_API_PROTOCOL_VERSION);
    expect(result.revision).toBe(1);
    expect(result.workerInstanceId).toBe("worker-1");
    expect(result.config.repositoryRoot).toBe(fixture!.root);
    expect(result.workspace.kind).toBe("git-disabled");
    // Host filesystem paths are stripped from the workspace identity.
    expect(result.workspace).not.toHaveProperty("controlRoot");
    expect(result.workspace).not.toHaveProperty("worktreePath");
  });

  it("round-trips a snapshot read and compare-and-swap mutation", async () => {
    await setup(["run-a"]);
    const { token } = await ui!.issueWorkerStateCredential("run-a");

    const snapshot = await ok<RunStateSnapshot>(await api("run-a", "snapshot", { token }));
    expect(snapshot.revision).toBe(1);

    const mutated = await ok<RunStateSnapshot>(
      await api("run-a", "compare-and-swap", {
        token,
        body: {
          requestId: "req-cas-1",
          idempotencyKey: "cas-1",
          expectedRevision: snapshot.revision,
          transition: transitionFrom(snapshot, { phase: "reflecting" }),
          artifacts: [{ ref: { kind: "packet", id: "pkt-1" }, contents: "{\"role\":\"reflector\"}" }],
        },
      }),
    );
    expect(mutated.revision).toBe(2);
    expect(mutated.state.phase).toBe("reflecting");

    const reloaded = await ok<RunStateSnapshot>(await api("run-a", "snapshot", { token }));
    expect(reloaded.revision).toBe(2);
    expect(reloaded.state.phase).toBe("reflecting");

    const artifact = await ok<{ contents: string | null }>(
      await api("run-a", "artifacts/read", { token, body: { ref: { kind: "packet", id: "pkt-1" } } }),
    );
    expect(artifact.contents).toBe("{\"role\":\"reflector\"}");
  });

  it("rejects a stale revision with 409 and code stale_revision", async () => {
    await setup(["run-a"]);
    const { token } = await ui!.issueWorkerStateCredential("run-a");
    const snapshot = await ok<RunStateSnapshot>(await api("run-a", "snapshot", { token }));

    const response = await api("run-a", "compare-and-swap", {
      token,
      body: {
        requestId: "req-stale",
        idempotencyKey: "stale-1",
        expectedRevision: snapshot.revision + 5,
        transition: transitionFrom(snapshot, { phase: "planning" }),
      },
    });
    // transition.state.revision (1) !== expectedRevision (6): invalid_mutation.
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_mutation",
    );

    const stale = await api("run-a", "compare-and-swap", {
      token,
      body: {
        requestId: "req-stale-2",
        idempotencyKey: "stale-2",
        expectedRevision: snapshot.revision,
        transition: {
          state: { ...snapshot.state, revision: snapshot.revision, updatedAt: NOW },
          events: [],
        },
      },
    });
    expect(stale.status).toBe(200); // valid CAS at current revision
    const conflict = await api("run-a", "compare-and-swap", {
      token,
      body: {
        requestId: "req-stale-3",
        idempotencyKey: "stale-3",
        expectedRevision: snapshot.revision,
        transition: {
          state: { ...snapshot.state, revision: snapshot.revision, updatedAt: NOW },
          events: [],
        },
      },
    });
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as { error: { code: string } };
    expect(conflictBody.error.code).toBe("stale_revision");
  });

  it("replays a lost-response retry without duplicating events or revisions", async () => {
    await setup(["run-a"]);
    const { token } = await ui!.issueWorkerStateCredential("run-a");
    const snapshot = await ok<RunStateSnapshot>(await api("run-a", "snapshot", { token }));

    const first = await ok<RunStateSnapshot>(
      await api("run-a", "events", {
        token,
        body: {
          requestId: "req-event-1",
          idempotencyKey: "event-key-1",
          type: "run.note_added",
          detail: { note: "hello" },
        },
      }),
    );
    expect(first.revision).toBe(snapshot.revision + 1);

    // Lost response: same idempotency key and payload, fresh request ID.
    const retry = await ok<RunStateSnapshot>(
      await api("run-a", "events", {
        token,
        body: {
          requestId: "req-event-1-retry",
          idempotencyKey: "event-key-1",
          type: "run.note_added",
          detail: { note: "hello" },
        },
      }),
    );
    expect(retry).toEqual(first);

    const reloaded = await ok<RunStateSnapshot>(await api("run-a", "snapshot", { token }));
    expect(reloaded.revision).toBe(first.revision);
    expect(reloaded.state.lastEventSequence).toBe(first.state.lastEventSequence);

    // Same key with a different payload is an idempotency conflict.
    const conflict = await api("run-a", "events", {
      token,
      body: {
        requestId: "req-event-2",
        idempotencyKey: "event-key-1",
        type: "run.note_added",
        detail: { note: "different" },
      },
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe(
      "idempotency_conflict",
    );
  });

  it("fences stale-worker mutations after lease replacement", async () => {
    await setup(["run-a"]);
    const { token } = await ui!.issueWorkerStateCredential("run-a");
    const snapshot = await ok<RunStateSnapshot>(await api("run-a", "snapshot", { token }));

    const leaseA = await ok<{ fencingToken: number }>(
      await api("run-a", "lease/acquire", {
        token,
        body: { workerInstanceId: "worker-a", ttlMs: 60_000, requestId: "req-lease-a" },
      }),
    );
    expect(leaseA.fencingToken).toBe(1);

    // Mutations without the active lease's token are rejected.
    const noToken = await api("run-a", "compare-and-swap", {
      token,
      body: {
        requestId: "req-no-token",
        idempotencyKey: "no-token-1",
        expectedRevision: snapshot.revision,
        transition: transitionFrom(snapshot, { phase: "reflecting" }),
      },
    });
    expect(noToken.status).toBe(409);
    expect(((await noToken.json()) as { error: { code: string } }).error.code).toBe(
      "lease_required",
    );

    const advanced = await ok<RunStateSnapshot>(
      await api("run-a", "compare-and-swap", {
        token,
        body: {
          requestId: "req-advance",
          idempotencyKey: "advance-1",
          workerInstanceId: "worker-a",
          fencingToken: leaseA.fencingToken,
          expectedRevision: snapshot.revision,
          transition: transitionFrom(snapshot, { phase: "reflecting" }),
        },
      }),
    );
    expect(advanced.revision).toBe(snapshot.revision + 1);

    // Worker A is replaced: release, then worker B acquires with a greater token.
    await ok(
      await api("run-a", "lease/release", {
        token,
        body: {
          workerInstanceId: "worker-a",
          fencingToken: leaseA.fencingToken,
          requestId: "req-release-a",
        },
      }),
    );
    const leaseB = await ok<{ fencingToken: number }>(
      await api("run-a", "lease/acquire", {
        token,
        body: { workerInstanceId: "worker-b", ttlMs: 60_000, requestId: "req-lease-b" },
      }),
    );
    expect(leaseB.fencingToken).toBeGreaterThan(leaseA.fencingToken);

    const stale = await api("run-a", "compare-and-swap", {
      token,
      body: {
        requestId: "req-stale-worker",
        idempotencyKey: "stale-worker-1",
        workerInstanceId: "worker-a",
        fencingToken: leaseA.fencingToken,
        expectedRevision: advanced.revision,
        transition: transitionFrom(advanced, {}),
      },
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      "stale_fencing_token",
    );
  });

  it("rejects a credential scoped to a different run with 403", async () => {
    await setup(["run-a", "run-b"]);
    const { token } = await ui!.issueWorkerStateCredential("run-a");

    const response = await api("run-b", "snapshot", { token });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("forbidden");
  });

  it("rejects missing and unknown credentials with 401", async () => {
    await setup(["run-a"]);
    const missing = await api("run-a", "snapshot", {});
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      "unauthorized",
    );

    const unknown = await api("run-a", "snapshot", { token: "f".repeat(64) });
    expect(unknown.status).toBe(401);
  });

  it("fails closed on protocol version mismatch", async () => {
    await setup(["run-a"]);
    const { token } = await ui!.issueWorkerStateCredential("run-a");

    const mismatched = await api("run-a", "snapshot", { token, protocol: "999" });
    expect(mismatched.status).toBe(426);
    expect(((await mismatched.json()) as { error: { code: string } }).error.code).toBe(
      "protocol_mismatch",
    );

    // The header is required: absent means fail closed too.
    const absent = await fetch(`${ui!.origin}${runStateApiPath("run-a", "snapshot")}`, {
      headers: { [RUN_STATE_API_AUTH_HEADER]: token },
    });
    expect(absent.status).toBe(426);
  });

  it("rejects caller-selected paths in artifact requests", async () => {
    await setup(["run-a"]);
    const { token } = await ui!.issueWorkerStateCredential("run-a");

    const rawPath = await api("run-a", "artifacts/read", {
      token,
      body: { path: "config.json" },
    });
    expect(rawPath.status).toBe(400);
    expect(((await rawPath.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_artifact_ref",
    );

    const smuggled = await api("run-a", "artifacts/write", {
      token,
      body: {
        ref: { kind: "packet", id: "pkt-1", path: "../../config.json" },
        contents: "{}",
        requestId: "req-smuggle",
        idempotencyKey: "smuggle-1",
      },
    });
    expect(smuggled.status).toBe(400);

    const traversal = await api("run-a", "artifacts/read", {
      token,
      body: { ref: { kind: "packet", id: "../escape" } },
    });
    expect(traversal.status).toBe(400);
    expect(((await traversal.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_artifact_ref",
    );
  });

  it("writes audit fields for worker mutations without credentials or bodies", async () => {
    const { stateRoot } = await setup(["run-a"]);
    const { token } = await ui!.issueWorkerStateCredential("run-a", {
      workerInstanceId: "worker-1",
    });
    const snapshot = await ok<RunStateSnapshot>(await api("run-a", "snapshot", { token }));

    const secretContents = "artifact-body-that-must-not-be-logged";
    await ok<RunStateSnapshot>(
      await api("run-a", "compare-and-swap", {
        token,
        body: {
          requestId: "req-audit-1",
          idempotencyKey: "audit-1",
          expectedRevision: snapshot.revision,
          transition: transitionFrom(snapshot, { phase: "reflecting" }),
          artifacts: [{ ref: { kind: "packet", id: "pkt-1" }, contents: secretContents }],
        },
      }),
    );

    const auditRaw = await readFile(
      path.join(stateRoot, "runs", "run-a", WORKER_STATE_AUDIT_LOG),
      "utf8",
    );
    const records = auditRaw
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      runId: "run-a",
      operation: "compare-and-swap",
      requestId: "req-audit-1",
      workerInstanceId: "worker-1",
      expectedRevision: snapshot.revision,
      resultingRevision: snapshot.revision + 1,
      outcome: "ok",
    });
    expect(typeof records[0]!.at).toBe("string");

    // Never log credentials or artifact bodies.
    expect(auditRaw).not.toContain(token);
    expect(auditRaw).not.toContain(secretContents);
  });

  it("supports heartbeat renewal, cancellation check, export-ready, and shutdown ack", async () => {
    await setup(["run-a"]);
    const { token } = await ui!.issueWorkerStateCredential("run-a", {
      workerInstanceId: "worker-1",
    });

    const lease = await ok<{ fencingToken: number; expiresAt: string }>(
      await api("run-a", "lease/acquire", {
        token,
        body: { workerInstanceId: "worker-1", ttlMs: 60_000, requestId: "req-lease-1" },
      }),
    );
    const renewed = await ok<{ fencingToken: number; expiresAt: string }>(
      await api("run-a", "lease/renew", {
        token,
        body: {
          workerInstanceId: "worker-1",
          fencingToken: lease.fencingToken,
          ttlMs: 120_000,
          requestId: "req-lease-2",
        },
      }),
    );
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(lease.expiresAt));

    const current = await ok<{ lease: { workerInstanceId: string } | null }>(
      await api("run-a", "lease", { token }),
    );
    expect(current.lease?.workerInstanceId).toBe("worker-1");

    const cancellation = await ok<{ requested: boolean }>(
      await api("run-a", "cancellation", { token }),
    );
    expect(cancellation.requested).toBe(false);

    const exported = await ok<RunStateSnapshot>(
      await api("run-a", "export-ready", {
        token,
        body: {
          requestId: "req-export-1",
          idempotencyKey: "export-1",
          fencingToken: lease.fencingToken,
          detail: { bundleHash: "sha256:abc" },
        },
      }),
    );
    expect(exported.state.lastEventSequence).toBeGreaterThan(0);

    const acknowledged = await ok<RunStateSnapshot>(
      await api("run-a", "shutdown-ack", {
        token,
        body: {
          requestId: "req-shutdown-1",
          idempotencyKey: "shutdown-1",
          fencingToken: lease.fencingToken,
          reason: "run completed",
        },
      }),
    );
    expect(acknowledged.revision).toBe(exported.revision + 1);

    const history = await store.readText("run-a", "events.jsonl");
    expect(history).toContain("worker.export_ready");
    expect(history).toContain("worker.shutdown_acknowledged");
  });
});

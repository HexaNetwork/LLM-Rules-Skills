import https from "node:https";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentCursorProviderProofTuple,
  findMatchingCursorProviderProof,
  loadCursorProviderProofCache,
} from "../../src/application/cursor-provider-proof.js";
import {
  assertCursorProviderRecorderRunArgv,
  buildCursorProviderRecorderRunArgv,
  buildCursorProviderSdkOptions,
  formatInvalidSdkChildOutput,
  parseCursorProviderSmokeProgress,
  recordLiveCursorProviderContract,
  type CursorProviderSdkRuntimeEvidence,
} from "../../src/application/cursor-provider-contract-recorder.js";
import { HarnessConfigSchema } from "../../src/config/schema.js";
import { createFakeDockerClient } from "../../src/infrastructure/container/fake-docker-client.js";
import { ensureCursorProviderTlsMaterial } from "../../src/infrastructure/provider-proxy/tls.js";

describe("live Cursor provider contract recorder", () => {
  const cleanups: Array<() => Promise<void>> = [];
  const dockerPolicy = HarnessConfigSchema.parse({ execution: { docker: {} } }).execution.docker;
  const containerRuntime: CursorProviderSdkRuntimeEvidence = {
    containerized: true,
    platform: "linux",
    arch: "x64",
    cwd: "/workspace",
    sandboxEnabled: true,
    sdkHelper: "@cursor/sdk-linux-x64",
  };

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("records SDK-shaped Bearer requests and persists a digest-scoped green proof", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-provider-recorder-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const tls = await ensureCursorProviderTlsMaterial(path.join(root, "tls"));
    const tuple = currentCursorProviderProofTuple({
      imageDigest: "sha256:worker",
      model: "cursor-model",
      tlsIdentity: tls.tlsIdentity,
      apiKey: "cursor_host_key_never_log",
    });
    const upstreamSession = "upstream_session_never_deliver";
    const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = new URL(String(url));
      const authorization = new Headers(init?.headers).get("authorization");
      expect(authorization).toBe(
        target.pathname === "/aiserver.v1.BidiService/BidiAppend" ||
          target.pathname === "/aiserver.v1.AgentService/RunSSE"
          ? `Bearer ${upstreamSession}`
          : "Bearer cursor_host_key_never_log",
      );
      if (target.pathname.includes("exchange_user_api_key")) {
        expect(target.origin).toBe("https://api2.cursor.sh");
        return new Response(JSON.stringify({ accessToken: upstreamSession }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (target.pathname === "/aiserver.v1.BidiService/BidiAppend") {
        const first = await (init?.body as ReadableStream<Uint8Array>).getReader().read();
        expect(first.value?.byteLength).toBeGreaterThan(0);
        return new Response("stream-response", {
          status: 200,
          headers: { "content-type": "application/connect+proto" },
        });
      }
      if (target.pathname === "/aiserver.v1.AgentService/RunSSE") {
        return new Response("agent-response", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      expect(target.href).toBe("https://api.cursor.com/v1/models");
      return new Response('{"models":[{"id":"cursor-model"}]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const report = await recordLiveCursorProviderContract({
      apiKey: "cursor_host_key_never_log",
      projectStateRoot: root,
      tuple,
      tls,
      docker: createFakeDockerClient(),
      dockerPolicy,
      fetch: upstream,
      runChild: async ({ endpoint, token, caCertificatePath }) => {
        await sdkRequest(`${endpoint}/auth/exchange_user_api_key`, token, caCertificatePath, "POST");
        await sdkRequest(`${endpoint}/v1/models`, token, caCertificatePath, "GET");
        await sdkRequest(
          `${endpoint}/aiserver.v1.BidiService/BidiAppend`,
          token,
          caCertificatePath,
          "POST",
        );
        await sdkRequest(
          `${endpoint}/aiserver.v1.AgentService/RunSSE`,
          token,
          caCertificatePath,
          "POST",
        );
        return {
          outputContainedHostKey: false,
          result: {
            ok: true,
            lifecycle: {
              create: true,
              send: true,
              stream: true,
              wait: true,
              resume: true,
              cancel: true,
              dispose: true,
            },
            credentialAbsence: credentialAbsenceEvidence(),
            gaps: [],
            runtime: containerRuntime,
          },
        };
      },
    });

    expect(report.ok).toBe(true);
    expect(report.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "POST", path: "/auth/exchange_user_api_key" }),
        expect.objectContaining({ method: "GET", path: "/v1/models" }),
        expect.objectContaining({
          method: "POST",
          path: "/aiserver.v1.BidiService/BidiAppend",
          requestBytes: expect.any(Number),
          streaming: true,
        }),
        expect.objectContaining({
          method: "POST",
          path: "/aiserver.v1.AgentService/RunSSE",
          responseBytes: expect.any(Number),
        }),
      ]),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "provider-stream-progress", ok: true }),
    );
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "direct-agent-absence", ok: true }),
        expect.objectContaining({ id: "delegated-agent-absence", ok: true }),
      ]),
    );
    expect(report.credentialAbsence).toEqual(credentialAbsenceEvidence());
    expect(upstream).toHaveBeenCalledTimes(4);
    const cached = await loadCursorProviderProofCache(root);
    expect(findMatchingCursorProviderProof(cached, tuple)?.ok).toBe(true);
    expect(JSON.stringify(cached)).not.toContain("cursor_host_key_never_log");
  });

  it("keeps the proof blocked when any SDK lifecycle operation is a gap", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-provider-recorder-gap-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const tls = await ensureCursorProviderTlsMaterial(path.join(root, "tls"));
    const tuple = currentCursorProviderProofTuple({
      imageDigest: "sha256:worker",
      model: "cursor-model",
      tlsIdentity: tls.tlsIdentity,
      apiKey: "cursor_host_key_never_log",
    });

    let observedBrokerToken = "";
    const report = await recordLiveCursorProviderContract({
      apiKey: "cursor_host_key_never_log",
      projectStateRoot: root,
      tuple,
      tls,
      docker: createFakeDockerClient(),
      dockerPolicy,
      fetch: vi.fn(async () =>
        new Response('{"models":[{"id":"cursor-model"}]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ) as typeof fetch,
      runChild: async ({ endpoint, token, caCertificatePath }) => {
        observedBrokerToken = token;
        await sdkRequest(`${endpoint}/v1/models`, token, caCertificatePath, "GET");
        return {
          outputContainedHostKey: false,
          result: {
            ok: true,
            lifecycle: {
              create: true,
              send: true,
              stream: true,
              wait: true,
              resume: true,
              cancel: false,
              dispose: true,
            },
            gaps: ["cancel unsupported"],
            diagnostics: [
              {
                source: "result",
                type: "RunError",
                code: "route_not_allowed",
                message:
                  `failed with ${token} and cursor_host_key_never_log`,
              },
            ],
            lifecycleStages: [
              { stage: "wait", status: "completed" },
              {
                stage: "initial-run",
                status: "failed",
                diagnostic: {
                  source: "result",
                  code: "route_not_allowed",
                  message: `failed with ${token}`,
                },
              },
            ],
            runtime: containerRuntime,
          },
        };
      },
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "sdk-lifecycle", ok: false }),
    );
    expect(report.sdkDiagnostics).toEqual([
      {
        source: "result",
        type: "RunError",
        code: "route_not_allowed",
        message: "failed with [REDACTED] and [REDACTED]",
      },
    ]);
    expect(report.lifecycleStages).toEqual(
      expect.arrayContaining([
        { stage: "wait", status: "completed" },
        expect.objectContaining({ stage: "initial-run", status: "failed" }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain(observedBrokerToken);
    expect(JSON.stringify(report)).not.toContain("cursor_host_key_never_log");
    expect(findMatchingCursorProviderProof(await loadCursorProviderProofCache(root), tuple)).toBe(
      undefined,
    );
  });

  it("keeps an otherwise-green proof blocked without direct and delegated absence evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-provider-recorder-absence-gap-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const tls = await ensureCursorProviderTlsMaterial(path.join(root, "tls"));
    const tuple = currentCursorProviderProofTuple({
      imageDigest: "sha256:worker",
      model: "cursor-model",
      tlsIdentity: tls.tlsIdentity,
      apiKey: "cursor_host_key_never_log",
    });
    const report = await recordLiveCursorProviderContract({
      apiKey: "cursor_host_key_never_log",
      projectStateRoot: root,
      tuple,
      tls,
      docker: createFakeDockerClient(),
      dockerPolicy,
      fetch: vi.fn(async () =>
        new Response('{"models":[{"id":"cursor-model"}]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ) as typeof fetch,
      runChild: async ({ endpoint, token, caCertificatePath }) => {
        await sdkRequest(`${endpoint}/v1/models`, token, caCertificatePath, "GET");
        return {
          outputContainedHostKey: false,
          result: {
            ok: true,
            lifecycle: {
              create: true,
              send: true,
              stream: true,
              wait: true,
              resume: true,
              cancel: true,
              dispose: true,
            },
            gaps: [],
            runtime: containerRuntime,
          },
        };
      },
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "direct-agent-absence", ok: false }),
        expect.objectContaining({ id: "delegated-agent-absence", ok: false }),
      ]),
    );
    expect(findMatchingCursorProviderProof(await loadCursorProviderProofCache(root), tuple)).toBe(
      undefined,
    );
  });

  it("builds a foreground hardened Linux-worker argv with no host credential", () => {
    const hostKey = "cursor_host_key_never_log";
    const argv = buildCursorProviderRecorderRunArgv({
      endpoint:
        "https://host.docker.internal:9443/provider-api/v1/runs/proof-run/cursor",
      token: "run-scoped-broker-token",
      caCertificatePath: "C:\\harness\\public\\cursor-provider-ca.pem",
      model: "cursor-model",
      imageDigest: "agent-harness-worker@sha256:worker",
      dockerPolicy,
      containerName: "ah-provider-proof-test",
      workspaceVolumeName: "ah-provider-proof-workspace-test",
    });

    expect(argv).toContain("--rm");
    expect(argv).not.toContain("-d");
    expect(argv).toEqual(
      expect.arrayContaining([
        "--security-opt",
        "seccomp=unconfined",
        "--cap-drop",
        "ALL",
        "--workdir",
        "/workspace",
        "--add-host",
        "host.docker.internal:host-gateway",
        "--entrypoint",
        "/opt/agent-harness/cli",
        "agent-harness-worker@sha256:worker",
        "cursor-provider-sdk-smoke-child",
      ]),
    );
    expect(argv.join("\n")).not.toContain(hostKey);
    expect(argv.join("\n")).not.toContain("CURSOR_API_KEY");
    expect(argv.join("\n")).not.toContain(process.cwd());
    expect(() =>
      assertCursorProviderRecorderRunArgv({
        argv,
        apiKey: hostKey,
        imageDigest: "agent-harness-worker@sha256:worker",
      }),
    ).not.toThrow();
    expect(
      buildCursorProviderSdkOptions({
        token: "run-scoped-broker-token",
        model: "cursor-model",
      }),
    ).toMatchObject({
      tools: [],
      local: {
        cwd: "/workspace",
        sandboxOptions: { enabled: true },
      },
    });
    expect(
      buildCursorProviderSdkOptions({
        token: "run-scoped-broker-token",
        model: "cursor-model",
        allowTools: true,
      }).tools,
    ).toBeUndefined();
    expect(
      formatInvalidSdkChildOutput(
        1,
        'CURSOR_PROVIDER_SMOKE_PROGRESS={"stage":"absence-create","status":"started"}\n',
        `${"x".repeat(2_000)}ACTUAL_FAILURE_AT_TAIL`,
      ),
    ).toContain("Last stage: absence-create=started");
  });

  it("keeps smoke progress readable in the reason while redacting credentials", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-provider-recorder-progress-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const tls = await ensureCursorProviderTlsMaterial(path.join(root, "tls"));
    const tuple = currentCursorProviderProofTuple({
      imageDigest: "sha256:worker",
      model: "cursor-model",
      tlsIdentity: tls.tlsIdentity,
      apiKey: "cursor_host_key_never_log",
    });
    const stdout =
      'CURSOR_PROVIDER_SMOKE_PROGRESS={"stage":"absence-create","status":"completed"}\n' +
      'CURSOR_PROVIDER_SMOKE_PROGRESS={"stage":"direct-absence-stream","status":"started"}\n' +
      "CURSOR_PROVIDER_SMOKE_PROGRESS=not-json\n";
    expect(parseCursorProviderSmokeProgress(stdout)).toEqual([
      { stage: "absence-create", status: "completed" },
      { stage: "direct-absence-stream", status: "started" },
    ]);

    const report = await recordLiveCursorProviderContract({
      apiKey: "cursor_host_key_never_log",
      projectStateRoot: root,
      tuple,
      tls,
      docker: createFakeDockerClient(),
      dockerPolicy,
      fetch: vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch,
      runChild: async () => ({
        outputContainedHostKey: false,
        result: {
          ok: false,
          lifecycleStages: parseCursorProviderSmokeProgress(stdout),
          error: formatInvalidSdkChildOutput(1, stdout, "cursor_host_key_never_log crashed"),
        },
      }),
    });

    expect(report.ok).toBe(false);
    expect(report.reason).toContain("Last stage: direct-absence-stream=started");
    expect(report.reason).toContain('CURSOR_PROVIDER_SMOKE_PROGRESS={"stage":"absence-create"');
    expect(report.reason).not.toContain("cursor_host_key_never_log");
    expect(report.lifecycleStages).toEqual([
      { stage: "absence-create", status: "completed" },
      { stage: "direct-absence-stream", status: "started" },
    ]);
  });

  it("rejects otherwise-green lifecycle evidence from host execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-provider-recorder-host-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const tls = await ensureCursorProviderTlsMaterial(path.join(root, "tls"));
    const tuple = currentCursorProviderProofTuple({
      imageDigest: "sha256:worker",
      model: "cursor-model",
      tlsIdentity: tls.tlsIdentity,
      apiKey: "cursor_host_key_never_log",
    });
    const report = await recordLiveCursorProviderContract({
      apiKey: "cursor_host_key_never_log",
      projectStateRoot: root,
      tuple,
      tls,
      docker: createFakeDockerClient(),
      dockerPolicy,
      fetch: vi.fn(async () =>
        new Response('{"models":[{"id":"cursor-model"}]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ) as typeof fetch,
      runChild: async ({ endpoint, token, caCertificatePath }) => {
        await sdkRequest(`${endpoint}/v1/models`, token, caCertificatePath, "GET");
        return {
          outputContainedHostKey: false,
          result: {
            ok: true,
            lifecycle: {
              create: true,
              send: true,
              stream: true,
              wait: true,
              resume: true,
              cancel: true,
              dispose: true,
            },
            gaps: [],
            runtime: {
              containerized: false,
              platform: "win32",
              arch: "x64",
              cwd: root,
              sandboxEnabled: false,
              sdkHelper: "@cursor/sdk-win32-x64",
            },
          },
        };
      },
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "sdk-runtime", ok: false }),
    );
    expect(findMatchingCursorProviderProof(await loadCursorProviderProofCache(root), tuple)).toBe(
      undefined,
    );
  });
});

function credentialAbsenceEvidence() {
  return {
    direct: {
      phase: "direct" as const,
      providerCompleted: true,
      toolSearchAttempted: true,
      taskAttempted: false,
      nestedTaskObserved: false,
      completionMarkerObserved: true,
      keyShapedCredentialObserved: false,
    },
    delegated: {
      phase: "delegated" as const,
      providerCompleted: true,
      toolSearchAttempted: true,
      taskAttempted: true,
      nestedTaskObserved: true,
      completionMarkerObserved: true,
      keyShapedCredentialObserved: false,
    },
  };
}

function sdkRequest(
  url: string,
  token: string,
  caCertificatePath: string,
  method: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port: target.port,
        path: target.pathname,
        servername: target.hostname,
        method,
        ca: readFileSync(caCertificatePath),
        headers: { authorization: `Bearer ${token}` },
      },
      (response) => {
        response.resume();
        response.on("end", resolve);
      },
    );
    request.on("error", reject);
    request.end(method === "POST" ? "{}" : undefined);
  });
}

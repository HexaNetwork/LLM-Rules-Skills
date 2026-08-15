import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkerProviderCredentialIssuer } from "../../src/application/worker-provider-credentials.js";
import {
  createDockerClient,
  probeDockerReadiness,
  realDockerSkipReason,
} from "../../src/infrastructure/container/index.js";
import {
  UNPROVEN_CURSOR_PROVIDER_CONTRACT,
} from "../../src/infrastructure/provider-proxy/cursor-provider-contract.js";
import { CursorProviderProxy } from "../../src/infrastructure/provider-proxy/cursor-provider-proxy.js";
import { startCursorProviderHttpsListener } from "../../src/infrastructure/provider-proxy/https-listener.js";
import {
  CURSOR_PROVIDER_CA_CONTAINER_PATH,
  ensureCursorProviderTlsMaterial,
} from "../../src/infrastructure/provider-proxy/tls.js";
import { cursorProviderApiPath } from "../../src/worker/provider-protocol.js";

describe("containerized Cursor provider contract", () => {
  it("uses the maintained Linux x64 image with its pinned SDK helper", async () => {
    const available = await dockerContractRuntime();
    if (!available) return;
    const { docker, image } = available;
    const result = await docker.exec(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--security-opt",
        "no-new-privileges:true",
        "--security-opt",
        "seccomp=unconfined",
        "--cap-drop",
        "ALL",
        "--entrypoint",
        "/bin/sh",
        image,
        "-c",
        "test -d /opt/agent-harness/node_modules/@cursor/sdk-linux-x64 && test \"$(node -p process.platform)\" = linux && test \"$(node -p process.arch)\" = x64",
      ],
      { timeoutMs: 120_000 },
    );
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  });

  it("reaches the host HTTPS broker through trusted host.docker.internal TLS", async () => {
    const available = await dockerContractRuntime();
    if (!available) return;
    const { docker, image } = available;
    const root = await mkdtemp(path.join(tmpdir(), "ah-provider-docker-"));
    const volume = `ah-provider-docker-${Date.now().toString(36)}`;
    const credentials = new WorkerProviderCredentialIssuer(path.join(root, "credentials"));
    const issued = await credentials.issue("run-a", { workerInstanceId: "worker-a" });
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer host-only-provider-key",
      );
      return new Response('{"models":[{"id":"cursor-model"}]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const proxy = new CursorProviderProxy({
      credentials,
      upstreamOrigins: {
        "cloud-api": "https://api.cursor.com/",
        "agent-api": "https://api2.cursor.sh/",
      },
      upstreamApiKey: "host-only-provider-key",
      contract: UNPROVEN_CURSOR_PROVIDER_CONTRACT,
      fetch: upstream,
    });
    const tls = await ensureCursorProviderTlsMaterial(path.join(root, "tls"));
    const listener = await startCursorProviderHttpsListener({ proxy, tls });
    try {
      const endpoint = `${listener.containerOrigin}${cursorProviderApiPath("run-a", "/v1/models")}`;
      const script =
        "fetch(process.env.PROVIDER_ENDPOINT,{headers:{authorization:`Bearer ${process.env.PROVIDER_TOKEN}`}})" +
        ".then(async r=>{process.stdout.write(JSON.stringify({status:r.status,body:await r.text()}));process.exitCode=r.ok?0:2})" +
        ".catch(e=>{process.stderr.write(String(e));process.exitCode=2})";
      const result = await docker.exec(
        [
          "run",
          "--rm",
          "--network",
          "bridge",
          "--user",
          "10001:10001",
          "--read-only",
          "--security-opt",
          "no-new-privileges:true",
          "--security-opt",
          "seccomp=unconfined",
          "--cap-drop",
          "ALL",
          "--add-host",
          "host.docker.internal:host-gateway",
          "--workdir",
          "/workspace",
          "--mount",
          `type=volume,source=${volume},target=/workspace`,
          "--mount",
          `type=bind,source=${tls.caCertificatePath},target=${CURSOR_PROVIDER_CA_CONTAINER_PATH},readonly`,
          "--env",
          `NODE_EXTRA_CA_CERTS=${CURSOR_PROVIDER_CA_CONTAINER_PATH}`,
          "--env",
          `PROVIDER_ENDPOINT=${endpoint}`,
          "--env",
          `PROVIDER_TOKEN=${issued.token}`,
          "--entrypoint",
          "/usr/local/bin/node",
          image,
          "-e",
          script,
        ],
        { timeoutMs: 120_000 },
      );
      expect(result.exitCode, result.stderr || result.stdout).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 200 });
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(result.stdout).not.toContain("host-only-provider-key");
      expect(result.stderr).not.toContain("host-only-provider-key");
    } finally {
      proxy.close();
      await listener.close().catch(() => undefined);
      await credentials.revoke("run-a").catch(() => undefined);
      await docker.exec(["volume", "rm", "-f", volume]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function dockerContractRuntime(): Promise<
  | {
      docker: ReturnType<typeof createDockerClient>;
      image: string;
    }
  | undefined
> {
  const image = process.env.AGENT_HARNESS_CURSOR_CREDENTIAL_IMAGE?.trim();
  if (!image) {
    console.info(
      "Skipped: set AGENT_HARNESS_CURSOR_CREDENTIAL_IMAGE to a maintained worker digest.",
    );
    return undefined;
  }
  const docker = createDockerClient();
  const skip = realDockerSkipReason(await probeDockerReadiness(docker));
  if (skip) {
    if (process.env.AGENT_HARNESS_REQUIRE_DOCKER === "1") throw new Error(skip);
    console.info(skip);
    return undefined;
  }
  return { docker, image };
}

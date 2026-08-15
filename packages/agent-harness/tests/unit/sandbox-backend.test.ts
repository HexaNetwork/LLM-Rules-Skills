import { describe, expect, it } from "vitest";
import { HarnessConfigSchema } from "../../src/config/schema.js";
import { createFakeDockerClient } from "../../src/infrastructure/container/fake-docker-client.js";
import { DockerSandboxProvider } from "../../src/sandbox/index.js";
import { SandboxAgentBackend } from "../../src/infrastructure/agents/sandbox-backend.js";

const IMAGE =
  "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

describe("SandboxAgentBackend", () => {
  it("creates, executes, destroys, and revokes each bounded invocation", async () => {
    const result = {
      output: '{"summary":"done","changedFiles":[]}',
      providerSessionId: "session-1",
      providerSessionReused: false,
    };
    const docker = createFakeDockerClient({
      healthy: true,
      scripted: [
        {
          match: "exec -i",
          result: {
            exitCode: 0,
            stdout: `${JSON.stringify(result)}\n`,
            stderr: "",
            timedOut: false,
          },
        },
        {
          match: "exec -i",
          result: {
            exitCode: 0,
            stdout: `${JSON.stringify(result)}\n`,
            stderr: "",
            timedOut: false,
          },
        },
      ],
    });
    const issued: string[] = [];
    const revoked: string[] = [];
    const config = HarnessConfigSchema.parse({});
    const backend = new SandboxAgentBackend({
      sandboxProvider: new DockerSandboxProvider(docker),
      image: () => IMAGE,
      dockerPolicy: () => config.execution.docker,
      rpcUrl: () => "http://host.docker.internal:8787",
      issueCapability: async (runId, workerInstanceId) => {
        issued.push(`${runId}:${workerInstanceId}`);
        return { token: `capability-${issued.length}` };
      },
      revokeCapability: async (runId) => {
        revoked.push(runId);
      },
    });

    const invoke = () =>
      backend.run({
        runId: "run-1",
        role: "implementer",
        model: "test-model",
        prompt: "Implement one bounded task",
        cwd: "D:/state/worktrees/run-1",
        signal: new AbortController().signal,
      });
    await invoke();
    await invoke();

    expect(issued).toHaveLength(2);
    expect(revoked).toEqual(["run-1", "run-1"]);
    const runs = docker.calls.filter((call) => call.args[0] === "run");
    const execs = docker.calls.filter((call) => call.args[0] === "exec");
    const removals = docker.calls.filter(
      (call) => call.args[0] === "rm" && call.args[1] === "-f",
    );
    expect(runs).toHaveLength(2);
    expect(execs).toHaveLength(2);
    expect(removals).toHaveLength(2);
    expect(runs[0]?.args).toEqual(
      expect.arrayContaining([
        "--env",
        "HARNESS_RPC_URL=http://host.docker.internal:8787",
        "--env",
        "HARNESS_WORKER_TOKEN=capability-1",
      ]),
    );
    const argv = runs.flatMap((call) => call.args).join(" ");
    expect(argv).not.toMatch(
      /CURSOR_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GH_TOKEN|GITHUB_TOKEN|\/run-state|\/run\/secrets/,
    );
    expect(execs[0]?.options?.input).toContain('"runId":"run-1"');
    expect(execs[0]?.args).toEqual(
      expect.arrayContaining(["-i", "/opt/agent-harness/cli", "sandbox-agent-child"]),
    );
  });
});

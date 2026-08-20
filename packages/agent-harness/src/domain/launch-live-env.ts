export const LIVE_WORKER_IMAGE = "agent-harness-worker:local";

export type LaunchLiveEnv = {
  AGENT_HARNESS_AGENTS: "cursor";
  AGENT_HARNESS_SANDBOX: "docker";
  AGENT_HARNESS_WORKER_IMAGE: string;
};

export type ResolveLaunchLiveEnvInput = {
  dockerReady: boolean;
  cursorApiKey?: string | null;
};

export function resolveLaunchLiveEnv(input: ResolveLaunchLiveEnvInput): LaunchLiveEnv | undefined {
  const key = input.cursorApiKey?.trim();
  if (!input.dockerReady || !key) return undefined;
  return {
    AGENT_HARNESS_AGENTS: "cursor",
    AGENT_HARNESS_SANDBOX: "docker",
    AGENT_HARNESS_WORKER_IMAGE: LIVE_WORKER_IMAGE,
  };
}

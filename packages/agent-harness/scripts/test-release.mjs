import { spawnSync } from "node:child_process";

const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "test:docker"], {
  stdio: "inherit",
  env: { ...process.env, AGENT_HARNESS_DOCKER_REQUIRED: "1" },
});
process.exitCode = result.status ?? 1;

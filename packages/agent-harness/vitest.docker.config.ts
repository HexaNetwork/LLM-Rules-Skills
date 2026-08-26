import { defineConfig } from "vitest/config";

/**
 * Real-Docker isolation lane. Safe to run without Docker — tests skip with an
 * explicit capability reason via `realDockerSkipReason`.
 */
export default defineConfig({
  test: {
    include: ["tests/docker/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    environment: "node",
    testTimeout: 180_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
});

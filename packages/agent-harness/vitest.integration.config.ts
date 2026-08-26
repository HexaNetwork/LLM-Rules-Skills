import { defineConfig } from "vitest/config";

const maxWorkers = process.env.VITEST_MAX_WORKERS
  ? Number(process.env.VITEST_MAX_WORKERS)
  : process.platform === "win32"
    ? 1
    : undefined;

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    environment: "node",
    testTimeout: 30_000,
    ...(maxWorkers != null && Number.isFinite(maxWorkers) ? { maxWorkers } : {}),
  },
});

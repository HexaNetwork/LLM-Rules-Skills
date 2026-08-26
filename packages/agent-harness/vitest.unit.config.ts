import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    environment: "node",
    testTimeout: 10_000,
    // Several unit files spawn many Git processes against temporary repositories.
    // On high-core Windows hosts, unconstrained file-level parallelism causes
    // filesystem/process contention and makes otherwise-fast tests hit this timeout.
    maxWorkers: 4,
  },
});

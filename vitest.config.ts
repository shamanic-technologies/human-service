import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // CI runs on the shared prod box (GITHUB-PRIVATE-1128), ~3x slower than a GitHub-hosted runner.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    fileParallelism: false,
    maxWorkers: 1,
  },
});

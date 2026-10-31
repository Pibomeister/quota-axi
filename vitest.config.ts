import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    // Many tests spawn the real CLI, with child limits of 10s or more each.
    // The 5s default is shorter than those limits and fails on a busy host.
    testTimeout: 60_000,
  },
});

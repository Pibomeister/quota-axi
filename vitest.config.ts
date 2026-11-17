import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Absolute path. A relative `./test/setup.ts` is resolved from the directory
// that contains this checkout, so a nested worktree loads the outer tree's
// setup file instead of this one.
const setupFile = fileURLToPath(new URL("./test/setup.ts", import.meta.url));

export default defineConfig({
  test: {
    setupFiles: [setupFile],
    // Many tests spawn the real CLI, with child limits of 10s or more each.
    // The 5s default is shorter than those limits and fails on a busy host.
    testTimeout: 60_000,
  },
});

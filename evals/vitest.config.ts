import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "static/fixtures/**"],
    testTimeout: 30_000,
    // Scenarios share one running API; keep them sequential so log lookups stay unambiguous.
    fileParallelism: false,
  },
});

import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Scenarios gate only for milestones listed as active (see milestones.json). Static and contract tests always run.
const { active } = JSON.parse(readFileSync(new URL("./milestones.json", import.meta.url), "utf8")) as { active: string[] };
const scenarioGlobs = active.map((m) => `scenarios/${m}/**/*.test.ts`);

export default defineConfig({
  test: {
    include: ["static/**/*.test.ts", "contract/**/*.test.ts", ...scenarioGlobs],
    exclude: ["node_modules/**", "static/fixtures/**"],
    testTimeout: 30_000,
    // Scenarios share one running API; keep them sequential so log lookups stay unambiguous.
    fileParallelism: false,
  },
});

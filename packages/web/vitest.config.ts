import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      include: [
        "src/components/analysis/chart-projection.ts",
        "src/lib/equity-chart.ts",
        "src/lib/funding.ts",
      ],
      thresholds: {
        lines: 90,
        statements: 90,
        branches: 80,
        functions: 90,
      },
    },
  },
});

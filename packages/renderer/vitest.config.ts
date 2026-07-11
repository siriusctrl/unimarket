import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/request.ts"],
      thresholds: {
        lines: 95,
        statements: 95,
        branches: 90,
        functions: 95
      }
    }
  }
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
  },
  coverage: {
    provider: "v8",
    reporter: ["text", "lcov", "html"],
    include: ["src/**/*.ts"],
    exclude: ["src/cli/index.ts", "src/**/*.d.ts"],
    thresholds: {
      lines: 60,
      functions: 60,
      branches: 60,
      statements: 60,
    },
  },
});

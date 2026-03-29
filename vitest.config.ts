import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/cli/index.ts",
        "src/**/*.d.ts",
        // Inngest workflow orchestration files are integration-tested via E2E,
        // not unit-testable without full Inngest mocking. Exclude from coverage.
        "src/inngest/workflows/agent-task-lifecycle.ts",
        "src/inngest/workflows/agent-dispatch.ts",
        "src/inngest/workflows/cleanup.ts",
      ],
      reportOnFailure: true,
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 60,
        statements: 60,
      },
    },
  },
});

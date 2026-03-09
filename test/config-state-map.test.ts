// ---------------------------------------------------------------------------
// Unit tests for ORCA_STATE_MAP parsing and validation in loadConfig()
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  VALID_STATE_MAP_VALUES,
  getStateMapOverrides,
  type OrcaConfig,
} from "../src/config/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalEnv(): Record<string, string> {
  return {
    ORCA_LINEAR_API_KEY: "test-api-key",
    ORCA_LINEAR_WEBHOOK_SECRET: "test-webhook-secret",
    ORCA_LINEAR_PROJECT_IDS: '["proj-1"]',
    ORCA_TUNNEL_HOSTNAME: "test.example.com",
  };
}

async function loadConfigWithEnv(
  env: Record<string, string | undefined>,
): Promise<OrcaConfig> {
  // Reset module so dotenvConfig() and readEnv() see fresh process.env
  vi.resetModules();
  const saved = { ...process.env };

  // Clear relevant keys then apply env
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ORCA_")) delete process.env[key];
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }

  try {
    const { loadConfig } = await import("../src/config/index.js");
    return loadConfig();
  } finally {
    // Restore
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("ORCA_")) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
}

// ---------------------------------------------------------------------------
// VALID_STATE_MAP_VALUES
// ---------------------------------------------------------------------------

describe("VALID_STATE_MAP_VALUES", () => {
  test("contains expected values", () => {
    expect(VALID_STATE_MAP_VALUES).toContain("backlog");
    expect(VALID_STATE_MAP_VALUES).toContain("ready");
    expect(VALID_STATE_MAP_VALUES).toContain("running");
    expect(VALID_STATE_MAP_VALUES).toContain("in_review");
    expect(VALID_STATE_MAP_VALUES).toContain("done");
    expect(VALID_STATE_MAP_VALUES).toContain("skip");
  });
});

// ---------------------------------------------------------------------------
// ORCA_STATE_MAP env var parsing
// ---------------------------------------------------------------------------

describe("ORCA_STATE_MAP parsing", () => {
  test("stateMapOverrides is undefined when env var is not set", async () => {
    const config = await loadConfigWithEnv(makeMinimalEnv());
    expect(config.stateMapOverrides).toBeUndefined();
  });

  test("parses valid JSON object into stateMapOverrides", async () => {
    const config = await loadConfigWithEnv({
      ...makeMinimalEnv(),
      ORCA_STATE_MAP: JSON.stringify({
        "Done Pending Deployment": "done",
        "QA Review": "in_review",
      }),
    });
    expect(config.stateMapOverrides).toEqual({
      "Done Pending Deployment": "done",
      "QA Review": "in_review",
    });
  });

  test("accepts all valid status values", async () => {
    const map: Record<string, string> = {};
    for (const value of VALID_STATE_MAP_VALUES) {
      map[`State ${value}`] = value;
    }
    const config = await loadConfigWithEnv({
      ...makeMinimalEnv(),
      ORCA_STATE_MAP: JSON.stringify(map),
    });
    expect(config.stateMapOverrides).toEqual(map);
  });

  test("exits on invalid JSON", async () => {
    const mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await loadConfigWithEnv({
        ...makeMinimalEnv(),
        ORCA_STATE_MAP: "not valid json {",
      });
    } catch {
      // process.exit may throw in test environment
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    const errorOutput = mockError.mock.calls.flat().join(" ");
    expect(errorOutput).toMatch(/ORCA_STATE_MAP/);

    mockExit.mockRestore();
    mockError.mockRestore();
  });

  test("exits when JSON is valid but not an object (array)", async () => {
    const mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await loadConfigWithEnv({
        ...makeMinimalEnv(),
        ORCA_STATE_MAP: '["done", "ready"]',
      });
    } catch {
      // may throw
    }

    expect(mockExit).toHaveBeenCalledWith(1);

    mockExit.mockRestore();
    mockError.mockRestore();
  });

  test("exits on invalid status value and includes the bad value in the error", async () => {
    const mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await loadConfigWithEnv({
        ...makeMinimalEnv(),
        ORCA_STATE_MAP: JSON.stringify({
          "QA Review": "in_review",
          "Shipped": "donee", // typo
        }),
      });
    } catch {
      // may throw
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    const errorOutput = mockError.mock.calls.flat().join(" ");
    expect(errorOutput).toMatch(/donee/);

    mockExit.mockRestore();
    mockError.mockRestore();
  });

  test("exits on multiple invalid status values and lists each bad value", async () => {
    const mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await loadConfigWithEnv({
        ...makeMinimalEnv(),
        ORCA_STATE_MAP: JSON.stringify({
          "State A": "invalid_one",
          "State B": "invalid_two",
        }),
      });
    } catch {
      // may throw
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    const errorOutput = mockError.mock.calls.flat().join(" ");
    expect(errorOutput).toMatch(/invalid_one/);
    expect(errorOutput).toMatch(/invalid_two/);

    mockExit.mockRestore();
    mockError.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// getStateMapOverrides helper
// ---------------------------------------------------------------------------

describe("getStateMapOverrides", () => {
  function makeConfig(
    overrides: Partial<OrcaConfig> = {},
  ): OrcaConfig {
    return {
      defaultCwd: undefined,
      projectRepoMap: new Map(),
      concurrencyCap: 1,
      sessionTimeoutMin: 45,
      maxRetries: 3,
      budgetWindowHours: 4,
      budgetMaxCostUsd: 100,
      schedulerIntervalSec: 10,
      claudePath: "claude",
      defaultMaxTurns: 50,
      implementSystemPrompt: "",
      reviewSystemPrompt: "",
      fixSystemPrompt: "",
      maxReviewCycles: 3,
      reviewMaxTurns: 30,
      disallowedTools: "",
      implementModel: "sonnet",
      reviewModel: "haiku",
      fixModel: "sonnet",
      deployStrategy: "none",
      deployPollIntervalSec: 30,
      deployTimeoutMin: 30,
      cleanupIntervalMin: 10,
      cleanupBranchMaxAgeMin: 60,
      resumeOnMaxTurns: true,
      resumeOnFix: true,
      maxWorktreeRetries: 3,
      port: 3000,
      dbPath: ":memory:",
      logPath: "./orca.log",
      logMaxSizeMb: 10,
      linearApiKey: "test",
      linearWebhookSecret: "test",
      linearProjectIds: ["proj-1"],
      tunnelHostname: "test.example.com",
      githubWebhookSecret: undefined,
      tunnelToken: "",
      cloudflaredPath: "cloudflared",
      externalTunnel: false,
      stateMapOverrides: undefined,
      ...overrides,
    };
  }

  test("returns undefined when stateMapOverrides is not set", () => {
    const config = makeConfig({ stateMapOverrides: undefined });
    expect(getStateMapOverrides(config)).toBeUndefined();
  });

  test("returns the overrides map when set", () => {
    const overrides = { "Done": "done", "Staging": "in_review" };
    const config = makeConfig({ stateMapOverrides: overrides });
    expect(getStateMapOverrides(config)).toEqual(overrides);
  });
});

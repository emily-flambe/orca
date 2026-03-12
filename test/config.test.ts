// ---------------------------------------------------------------------------
// loadConfig() env var parsing tests
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// Mock dotenv so it doesn't read .env files and pollute process.env
vi.mock("dotenv", () => ({
  config: vi.fn(),
}));

// Mock fs so ORCA_DEFAULT_CWD validation is controllable
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    statSync: vi.fn().mockReturnValue({ isDirectory: () => true }),
  };
});

import { loadConfig } from "../src/config/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REQUIRED_ENV: Record<string, string> = {
  ORCA_LINEAR_API_KEY: "lin_api_test",
  ORCA_LINEAR_WEBHOOK_SECRET: "webhook-secret",
  ORCA_LINEAR_PROJECT_IDS: '["proj-abc"]',
  ORCA_TUNNEL_HOSTNAME: "test.example.com",
};

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function withEnv(
  vars: Record<string, string | undefined>,
): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
  }
  setEnv(vars);
  return () => setEnv(saved);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let restore: () => void;

beforeEach(() => {
  // Start with a clean env containing only the required vars
  restore = withEnv({
    ...REQUIRED_ENV,
    // Clear every optional var that tests might have left set
    ORCA_DEFAULT_CWD: undefined,
    ORCA_CONCURRENCY_CAP: undefined,
    ORCA_SESSION_TIMEOUT_MIN: undefined,
    ORCA_MAX_RETRIES: undefined,
    ORCA_BUDGET_WINDOW_HOURS: undefined,
    ORCA_BUDGET_MAX_COST_USD: undefined,
    ORCA_BUDGET_MAX_TOKENS: undefined,
    ORCA_SCHEDULER_INTERVAL_SEC: undefined,
    ORCA_CLAUDE_PATH: undefined,
    ORCA_DEFAULT_MAX_TURNS: undefined,
    ORCA_IMPLEMENT_SYSTEM_PROMPT: undefined,
    ORCA_APPEND_SYSTEM_PROMPT: undefined,
    ORCA_REVIEW_SYSTEM_PROMPT: undefined,
    ORCA_FIX_SYSTEM_PROMPT: undefined,
    ORCA_MAX_REVIEW_CYCLES: undefined,
    ORCA_REVIEW_MAX_TURNS: undefined,
    ORCA_IMPLEMENT_MODEL: undefined,
    ORCA_REVIEW_MODEL: undefined,
    ORCA_FIX_MODEL: undefined,
    ORCA_DISALLOWED_TOOLS: undefined,
    ORCA_DEPLOY_STRATEGY: undefined,
    ORCA_DEPLOY_POLL_INTERVAL_SEC: undefined,
    ORCA_DEPLOY_TIMEOUT_MIN: undefined,
    ORCA_CLEANUP_INTERVAL_MIN: undefined,
    ORCA_CLEANUP_BRANCH_MAX_AGE_MIN: undefined,
    ORCA_INVOCATION_LOG_RETENTION_HOURS: undefined,
    ORCA_RESUME_ON_MAX_TURNS: undefined,
    ORCA_RESUME_ON_FIX: undefined,
    ORCA_MAX_WORKTREE_RETRIES: undefined,
    ORCA_PORT: undefined,
    ORCA_DB_PATH: undefined,
    ORCA_LOG_PATH: undefined,
    ORCA_LOG_MAX_SIZE_MB: undefined,
    ORCA_TASK_FILTER_LABEL: undefined,
    ORCA_GITHUB_WEBHOOK_SECRET: undefined,
    ORCA_TUNNEL_TOKEN: undefined,
    ORCA_CLOUDFLARED_PATH: undefined,
    ORCA_EXTERNAL_TUNNEL: undefined,
    ORCA_CRON_RETENTION_DAYS: undefined,
  });
});

afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

describe("default values when env vars are absent", () => {
  test("numeric defaults", () => {
    const cfg = loadConfig();
    expect(cfg.concurrencyCap).toBe(1);
    expect(cfg.sessionTimeoutMin).toBe(45);
    expect(cfg.maxRetries).toBe(3);
    expect(cfg.budgetWindowHours).toBe(4);
    expect(cfg.budgetMaxCostUsd).toBe(100.0);
    expect(cfg.budgetMaxTokens).toBe(50_000_000);
    expect(cfg.schedulerIntervalSec).toBe(10);
    expect(cfg.defaultMaxTurns).toBe(50);
    expect(cfg.maxReviewCycles).toBe(3);
    expect(cfg.reviewMaxTurns).toBe(30);
    expect(cfg.deployPollIntervalSec).toBe(30);
    expect(cfg.deployTimeoutMin).toBe(30);
    expect(cfg.cleanupIntervalMin).toBe(10);
    expect(cfg.cleanupBranchMaxAgeMin).toBe(60);
    expect(cfg.invocationLogRetentionHours).toBe(168);
    expect(cfg.maxWorktreeRetries).toBe(3);
    expect(cfg.port).toBe(3000);
    expect(cfg.logMaxSizeMb).toBe(10);
    expect(cfg.cronRetentionDays).toBe(7);
  });

  test("string defaults", () => {
    const cfg = loadConfig();
    expect(cfg.claudePath).toBe("claude");
    expect(cfg.implementModel).toBe("sonnet");
    expect(cfg.reviewModel).toBe("haiku");
    expect(cfg.fixModel).toBe("sonnet");
    expect(cfg.disallowedTools).toBe("");
    expect(cfg.deployStrategy).toBe("none");
    expect(cfg.dbPath).toBe("./orca.db");
    expect(cfg.logPath).toBe("./orca.log");
    expect(cfg.cloudflaredPath).toBe("cloudflared");
    expect(cfg.tunnelToken).toBe("");
  });

  test("boolean defaults", () => {
    const cfg = loadConfig();
    expect(cfg.resumeOnMaxTurns).toBe(true);
    expect(cfg.resumeOnFix).toBe(true);
    expect(cfg.externalTunnel).toBe(false);
  });

  test("optional fields default to undefined", () => {
    const cfg = loadConfig();
    expect(cfg.defaultCwd).toBeUndefined();
    expect(cfg.taskFilterLabel).toBeUndefined();
    expect(cfg.githubWebhookSecret).toBeUndefined();
  });

  test("projectRepoMap starts empty", () => {
    const cfg = loadConfig();
    expect(cfg.projectRepoMap).toBeInstanceOf(Map);
    expect(cfg.projectRepoMap.size).toBe(0);
  });

  test("system prompts are non-empty strings", () => {
    const cfg = loadConfig();
    expect(cfg.implementSystemPrompt.length).toBeGreaterThan(0);
    expect(cfg.reviewSystemPrompt.length).toBeGreaterThan(0);
    expect(cfg.fixSystemPrompt.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Required env vars
// ---------------------------------------------------------------------------

describe("required env vars", () => {
  test("parses linearApiKey", () => {
    const cfg = loadConfig();
    expect(cfg.linearApiKey).toBe("lin_api_test");
  });

  test("parses linearWebhookSecret", () => {
    const cfg = loadConfig();
    expect(cfg.linearWebhookSecret).toBe("webhook-secret");
  });

  test("parses linearProjectIds as array", () => {
    const cfg = loadConfig();
    expect(cfg.linearProjectIds).toEqual(["proj-abc"]);
  });

  test("parses tunnelHostname", () => {
    const cfg = loadConfig();
    expect(cfg.tunnelHostname).toBe("test.example.com");
  });

  test("exits when ORCA_LINEAR_API_KEY is missing", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ORCA_LINEAR_API_KEY: undefined });

    loadConfig();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ORCA_LINEAR_API_KEY"),
    );
  });

  test("exits when ORCA_LINEAR_WEBHOOK_SECRET is missing", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ORCA_LINEAR_WEBHOOK_SECRET: undefined });

    loadConfig();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ORCA_LINEAR_WEBHOOK_SECRET"),
    );
  });

  test("exits when ORCA_LINEAR_PROJECT_IDS is missing", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ORCA_LINEAR_PROJECT_IDS: undefined });

    loadConfig();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ORCA_LINEAR_PROJECT_IDS"),
    );
  });

  test("exits when ORCA_TUNNEL_HOSTNAME is missing", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ORCA_TUNNEL_HOSTNAME: undefined });

    loadConfig();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ORCA_TUNNEL_HOSTNAME"),
    );
  });
});

// ---------------------------------------------------------------------------
// ORCA_LINEAR_PROJECT_IDS JSON array parsing
// ---------------------------------------------------------------------------

describe("ORCA_LINEAR_PROJECT_IDS parsing", () => {
  test("parses multiple project IDs", () => {
    setEnv({ ORCA_LINEAR_PROJECT_IDS: '["proj-1","proj-2","proj-3"]' });
    const cfg = loadConfig();
    expect(cfg.linearProjectIds).toEqual(["proj-1", "proj-2", "proj-3"]);
  });

  test("exits on malformed JSON", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ORCA_LINEAR_PROJECT_IDS: "not-json" });

    loadConfig();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("exits on empty array", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ORCA_LINEAR_PROJECT_IDS: "[]" });

    loadConfig();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("exits on non-array JSON", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ORCA_LINEAR_PROJECT_IDS: '"single-string"' });

    loadConfig();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("exits on array of non-strings", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ORCA_LINEAR_PROJECT_IDS: "[1, 2, 3]" });

    loadConfig();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// Integer env vars
// ---------------------------------------------------------------------------

describe("integer env var parsing", () => {
  test("ORCA_CONCURRENCY_CAP overrides default", () => {
    setEnv({ ORCA_CONCURRENCY_CAP: "5" });
    expect(loadConfig().concurrencyCap).toBe(5);
  });

  test("ORCA_SESSION_TIMEOUT_MIN overrides default", () => {
    setEnv({ ORCA_SESSION_TIMEOUT_MIN: "60" });
    expect(loadConfig().sessionTimeoutMin).toBe(60);
  });

  test("ORCA_MAX_RETRIES overrides default", () => {
    setEnv({ ORCA_MAX_RETRIES: "5" });
    expect(loadConfig().maxRetries).toBe(5);
  });

  test("ORCA_PORT overrides default", () => {
    setEnv({ ORCA_PORT: "4000" });
    expect(loadConfig().port).toBe(4000);
  });

  test("ORCA_DEFAULT_MAX_TURNS overrides default", () => {
    setEnv({ ORCA_DEFAULT_MAX_TURNS: "100" });
    expect(loadConfig().defaultMaxTurns).toBe(100);
  });

  test("exits on non-numeric ORCA_CONCURRENCY_CAP", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ORCA_CONCURRENCY_CAP: "not-a-number" });

    loadConfig();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("exits on zero ORCA_CONCURRENCY_CAP", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ORCA_CONCURRENCY_CAP: "0" });

    loadConfig();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("exits on negative ORCA_MAX_RETRIES", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ORCA_MAX_RETRIES: "-1" });

    loadConfig();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("exits on float ORCA_PORT", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ORCA_PORT: "3000.5" });

    loadConfig();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("ORCA_CRON_RETENTION_DAYS overrides default", () => {
    setEnv({ ORCA_CRON_RETENTION_DAYS: "30" });
    expect(loadConfig().cronRetentionDays).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Positive number (float) env vars
// ---------------------------------------------------------------------------

describe("positive number env var parsing", () => {
  test("ORCA_BUDGET_MAX_COST_USD accepts decimal", () => {
    setEnv({ ORCA_BUDGET_MAX_COST_USD: "50.5" });
    expect(loadConfig().budgetMaxCostUsd).toBeCloseTo(50.5);
  });

  test("ORCA_BUDGET_WINDOW_HOURS accepts decimal", () => {
    setEnv({ ORCA_BUDGET_WINDOW_HOURS: "2.5" });
    expect(loadConfig().budgetWindowHours).toBeCloseTo(2.5);
  });

  test("ORCA_LOG_MAX_SIZE_MB accepts decimal", () => {
    setEnv({ ORCA_LOG_MAX_SIZE_MB: "5.5" });
    expect(loadConfig().logMaxSizeMb).toBeCloseTo(5.5);
  });

  test("exits on zero ORCA_BUDGET_MAX_COST_USD", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ORCA_BUDGET_MAX_COST_USD: "0" });

    loadConfig();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("exits on non-numeric ORCA_BUDGET_WINDOW_HOURS", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ORCA_BUDGET_WINDOW_HOURS: "abc" });

    loadConfig();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// Boolean env vars
// ---------------------------------------------------------------------------

describe("boolean env var parsing", () => {
  test.each([
    ["true", true],
    ["false", false],
    ["1", true],
    ["0", false],
    ["TRUE", true],
    ["FALSE", false],
  ])("ORCA_RESUME_ON_MAX_TURNS=%s → %s", (raw, expected) => {
    setEnv({ ORCA_RESUME_ON_MAX_TURNS: raw });
    expect(loadConfig().resumeOnMaxTurns).toBe(expected);
  });

  test.each([
    ["true", true],
    ["false", false],
    ["1", true],
    ["0", false],
  ])("ORCA_RESUME_ON_FIX=%s → %s", (raw, expected) => {
    setEnv({ ORCA_RESUME_ON_FIX: raw });
    expect(loadConfig().resumeOnFix).toBe(expected);
  });

  test.each([
    ["true", true],
    ["false", false],
  ])("ORCA_EXTERNAL_TUNNEL=%s → %s", (raw, expected) => {
    setEnv({ ORCA_EXTERNAL_TUNNEL: raw });
    expect(loadConfig().externalTunnel).toBe(expected);
  });

  test("exits on invalid boolean value", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ORCA_RESUME_ON_MAX_TURNS: "yes" });

    loadConfig();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("exits on invalid ORCA_EXTERNAL_TUNNEL value", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ORCA_EXTERNAL_TUNNEL: "on" });

    loadConfig();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// String env vars
// ---------------------------------------------------------------------------

describe("string env var parsing", () => {
  test("ORCA_CLAUDE_PATH overrides default", () => {
    setEnv({ ORCA_CLAUDE_PATH: "/usr/local/bin/claude" });
    expect(loadConfig().claudePath).toBe("/usr/local/bin/claude");
  });

  test("ORCA_IMPLEMENT_MODEL overrides default", () => {
    setEnv({ ORCA_IMPLEMENT_MODEL: "opus" });
    expect(loadConfig().implementModel).toBe("opus");
  });

  test("ORCA_REVIEW_MODEL overrides default", () => {
    setEnv({ ORCA_REVIEW_MODEL: "sonnet" });
    expect(loadConfig().reviewModel).toBe("sonnet");
  });

  test("ORCA_FIX_MODEL overrides default", () => {
    setEnv({ ORCA_FIX_MODEL: "opus" });
    expect(loadConfig().fixModel).toBe("opus");
  });

  test("ORCA_DB_PATH overrides default", () => {
    setEnv({ ORCA_DB_PATH: "/data/custom.db" });
    expect(loadConfig().dbPath).toBe("/data/custom.db");
  });

  test("ORCA_LOG_PATH overrides default", () => {
    setEnv({ ORCA_LOG_PATH: "/var/log/orca.log" });
    expect(loadConfig().logPath).toBe("/var/log/orca.log");
  });

  test("ORCA_CLOUDFLARED_PATH overrides default", () => {
    setEnv({ ORCA_CLOUDFLARED_PATH: "/usr/bin/cloudflared" });
    expect(loadConfig().cloudflaredPath).toBe("/usr/bin/cloudflared");
  });

  test("ORCA_TUNNEL_TOKEN overrides empty default", () => {
    setEnv({ ORCA_TUNNEL_TOKEN: "my-token" });
    expect(loadConfig().tunnelToken).toBe("my-token");
  });

  test("ORCA_DISALLOWED_TOOLS overrides empty default", () => {
    setEnv({ ORCA_DISALLOWED_TOOLS: "Bash,Edit" });
    expect(loadConfig().disallowedTools).toBe("Bash,Edit");
  });

  test("ORCA_TASK_FILTER_LABEL sets optional field", () => {
    setEnv({ ORCA_TASK_FILTER_LABEL: "orca" });
    expect(loadConfig().taskFilterLabel).toBe("orca");
  });

  test("ORCA_GITHUB_WEBHOOK_SECRET sets optional field", () => {
    setEnv({ ORCA_GITHUB_WEBHOOK_SECRET: "gh-secret" });
    expect(loadConfig().githubWebhookSecret).toBe("gh-secret");
  });
});

// ---------------------------------------------------------------------------
// ORCA_DEPLOY_STRATEGY
// ---------------------------------------------------------------------------

describe("ORCA_DEPLOY_STRATEGY", () => {
  test("accepts 'none'", () => {
    setEnv({ ORCA_DEPLOY_STRATEGY: "none" });
    expect(loadConfig().deployStrategy).toBe("none");
  });

  test("accepts 'github_actions'", () => {
    setEnv({ ORCA_DEPLOY_STRATEGY: "github_actions" });
    expect(loadConfig().deployStrategy).toBe("github_actions");
  });

  test("exits on invalid value", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ORCA_DEPLOY_STRATEGY: "kubernetes" });

    loadConfig();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

describe("system prompt env vars", () => {
  test("ORCA_IMPLEMENT_SYSTEM_PROMPT overrides default", () => {
    setEnv({ ORCA_IMPLEMENT_SYSTEM_PROMPT: "custom implement prompt" });
    expect(loadConfig().implementSystemPrompt).toBe("custom implement prompt");
  });

  test("ORCA_APPEND_SYSTEM_PROMPT used as fallback for implement prompt", () => {
    setEnv({
      ORCA_IMPLEMENT_SYSTEM_PROMPT: undefined,
      ORCA_APPEND_SYSTEM_PROMPT: "legacy prompt",
    });
    expect(loadConfig().implementSystemPrompt).toBe("legacy prompt");
  });

  test("ORCA_IMPLEMENT_SYSTEM_PROMPT takes precedence over ORCA_APPEND_SYSTEM_PROMPT", () => {
    setEnv({
      ORCA_IMPLEMENT_SYSTEM_PROMPT: "direct prompt",
      ORCA_APPEND_SYSTEM_PROMPT: "legacy prompt",
    });
    expect(loadConfig().implementSystemPrompt).toBe("direct prompt");
  });

  test("ORCA_REVIEW_SYSTEM_PROMPT overrides default", () => {
    setEnv({ ORCA_REVIEW_SYSTEM_PROMPT: "custom review prompt" });
    expect(loadConfig().reviewSystemPrompt).toBe("custom review prompt");
  });

  test("ORCA_FIX_SYSTEM_PROMPT overrides default", () => {
    setEnv({ ORCA_FIX_SYSTEM_PROMPT: "custom fix prompt" });
    expect(loadConfig().fixSystemPrompt).toBe("custom fix prompt");
  });
});

// ---------------------------------------------------------------------------
// ORCA_DEFAULT_CWD
// ---------------------------------------------------------------------------

describe("ORCA_DEFAULT_CWD", () => {
  test("sets defaultCwd when directory exists", async () => {
    const { existsSync, statSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);

    setEnv({ ORCA_DEFAULT_CWD: "/some/valid/dir" });
    expect(loadConfig().defaultCwd).toBe("/some/valid/dir");
  });

  test("exits when path does not exist", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    setEnv({ ORCA_DEFAULT_CWD: "/nonexistent/dir" });
    loadConfig();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("exits when path is a file, not a directory", async () => {
    const { existsSync, statSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as any);

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    setEnv({ ORCA_DEFAULT_CWD: "/path/to/file.txt" });
    loadConfig();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// loadConfig() tests
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted — must be at top level)
// ---------------------------------------------------------------------------

vi.mock("dotenv", () => ({
  config: vi.fn(),
}));

const mockExistsSync = vi.fn();
const mockStatSync = vi.fn();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    statSync: mockStatSync,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REQUIRED_ENV: Record<string, string> = {
  ORCA_LINEAR_API_KEY: "lin_api_test",
  ORCA_LINEAR_WEBHOOK_SECRET: "webhook-secret",
  ORCA_LINEAR_PROJECT_IDS: '["proj-uuid-1"]',
  ORCA_TUNNEL_HOSTNAME: "tunnel.example.com",
};

let savedEnv: Record<string, string | undefined>;

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function loadConfig() {
  vi.resetModules();
  const { loadConfig: load } = await import("../src/config/index.js");
  return load();
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Snapshot current env so we can restore it
  savedEnv = { ...process.env } as Record<string, string | undefined>;

  // Clear all orca-related env vars
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ORCA_") || key === "DOTENV_CONFIG_PATH") {
      delete process.env[key];
    }
  }

  // Apply the required vars by default
  setEnv(REQUIRED_ENV);

  // Default fs mocks: no ORCA_DEFAULT_CWD path exists (not called unless set)
  mockExistsSync.mockReturnValue(true);
  mockStatSync.mockReturnValue({ isDirectory: () => true });

  // Mock process.exit to throw so tests don't actually exit
  vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit(${code})`);
  });

  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  // Restore env
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Required env vars
// ---------------------------------------------------------------------------

describe("required env vars", () => {
  test("missing ORCA_LINEAR_API_KEY → exit(1)", async () => {
    delete process.env.ORCA_LINEAR_API_KEY;
    await expect(loadConfig()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("missing ORCA_LINEAR_WEBHOOK_SECRET → exit(1)", async () => {
    delete process.env.ORCA_LINEAR_WEBHOOK_SECRET;
    await expect(loadConfig()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("missing ORCA_LINEAR_PROJECT_IDS → exit(1)", async () => {
    delete process.env.ORCA_LINEAR_PROJECT_IDS;
    await expect(loadConfig()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("missing ORCA_TUNNEL_HOSTNAME → exit(1)", async () => {
    delete process.env.ORCA_TUNNEL_HOSTNAME;
    await expect(loadConfig()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// ORCA_LINEAR_PROJECT_IDS parsing
// ---------------------------------------------------------------------------

describe("ORCA_LINEAR_PROJECT_IDS parsing", () => {
  test("valid JSON array is accepted", async () => {
    process.env.ORCA_LINEAR_PROJECT_IDS = '["proj-1", "proj-2"]';
    const cfg = await loadConfig();
    expect(cfg.linearProjectIds).toEqual(["proj-1", "proj-2"]);
  });

  test("empty JSON array → exit(1)", async () => {
    process.env.ORCA_LINEAR_PROJECT_IDS = "[]";
    await expect(loadConfig()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("non-array JSON (string) → exit(1)", async () => {
    process.env.ORCA_LINEAR_PROJECT_IDS = '"just-a-string"';
    await expect(loadConfig()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("array with non-strings → exit(1)", async () => {
    process.env.ORCA_LINEAR_PROJECT_IDS = "[1, 2]";
    await expect(loadConfig()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("invalid JSON → exit(1)", async () => {
    process.env.ORCA_LINEAR_PROJECT_IDS = "not-json";
    await expect(loadConfig()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// ORCA_DEFAULT_CWD
// ---------------------------------------------------------------------------

describe("ORCA_DEFAULT_CWD", () => {
  test("not set → defaultCwd is undefined", async () => {
    delete process.env.ORCA_DEFAULT_CWD;
    const cfg = await loadConfig();
    expect(cfg.defaultCwd).toBeUndefined();
  });

  test("set to a valid directory → accepted", async () => {
    process.env.ORCA_DEFAULT_CWD = "/valid/path";
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    const cfg = await loadConfig();
    expect(cfg.defaultCwd).toBe("/valid/path");
  });

  test("set to non-existent path → exit(1)", async () => {
    process.env.ORCA_DEFAULT_CWD = "/nonexistent/path";
    mockExistsSync.mockReturnValue(false);
    await expect(loadConfig()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("set to a file (not a directory) → exit(1)", async () => {
    process.env.ORCA_DEFAULT_CWD = "/some/file.txt";
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ isDirectory: () => false });
    await expect(loadConfig()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

describe("default values", () => {
  test("concurrencyCap defaults to 1", async () => {
    const cfg = await loadConfig();
    expect(cfg.concurrencyCap).toBe(1);
  });

  test("sessionTimeoutMin defaults to 45", async () => {
    const cfg = await loadConfig();
    expect(cfg.sessionTimeoutMin).toBe(45);
  });

  test("maxRetries defaults to 3", async () => {
    const cfg = await loadConfig();
    expect(cfg.maxRetries).toBe(3);
  });

  test("budgetWindowHours defaults to 4", async () => {
    const cfg = await loadConfig();
    expect(cfg.budgetWindowHours).toBe(4);
  });

  test("budgetMaxCostUsd defaults to 100", async () => {
    const cfg = await loadConfig();
    expect(cfg.budgetMaxCostUsd).toBe(100);
  });

  test("budgetMaxTokens defaults to 50_000_000", async () => {
    const cfg = await loadConfig();
    expect(cfg.budgetMaxTokens).toBe(50_000_000);
  });

  test("schedulerIntervalSec defaults to 10", async () => {
    const cfg = await loadConfig();
    expect(cfg.schedulerIntervalSec).toBe(10);
  });

  test("claudePath defaults to 'claude'", async () => {
    const cfg = await loadConfig();
    expect(cfg.claudePath).toBe("claude");
  });

  test("defaultMaxTurns defaults to 50", async () => {
    const cfg = await loadConfig();
    expect(cfg.defaultMaxTurns).toBe(50);
  });

  test("maxReviewCycles defaults to 3", async () => {
    const cfg = await loadConfig();
    expect(cfg.maxReviewCycles).toBe(3);
  });

  test("reviewMaxTurns defaults to 30", async () => {
    const cfg = await loadConfig();
    expect(cfg.reviewMaxTurns).toBe(30);
  });

  test("implementModel defaults to 'sonnet'", async () => {
    const cfg = await loadConfig();
    expect(cfg.implementModel).toBe("sonnet");
  });

  test("reviewModel defaults to 'haiku'", async () => {
    const cfg = await loadConfig();
    expect(cfg.reviewModel).toBe("haiku");
  });

  test("fixModel defaults to 'sonnet'", async () => {
    const cfg = await loadConfig();
    expect(cfg.fixModel).toBe("sonnet");
  });

  test("deployStrategy defaults to 'none'", async () => {
    const cfg = await loadConfig();
    expect(cfg.deployStrategy).toBe("none");
  });

  test("resumeOnMaxTurns defaults to true", async () => {
    const cfg = await loadConfig();
    expect(cfg.resumeOnMaxTurns).toBe(true);
  });

  test("resumeOnFix defaults to true", async () => {
    const cfg = await loadConfig();
    expect(cfg.resumeOnFix).toBe(true);
  });

  test("externalTunnel defaults to false", async () => {
    const cfg = await loadConfig();
    expect(cfg.externalTunnel).toBe(false);
  });

  test("cloudflaredPath defaults to 'cloudflared'", async () => {
    const cfg = await loadConfig();
    expect(cfg.cloudflaredPath).toBe("cloudflared");
  });

  test("cronRetentionDays defaults to 7", async () => {
    const cfg = await loadConfig();
    expect(cfg.cronRetentionDays).toBe(7);
  });

  test("port defaults to 3000", async () => {
    const cfg = await loadConfig();
    expect(cfg.port).toBe(3000);
  });

  test("dbPath defaults to './orca.db'", async () => {
    const cfg = await loadConfig();
    expect(cfg.dbPath).toBe("./orca.db");
  });

  test("logPath defaults to './orca.log'", async () => {
    const cfg = await loadConfig();
    expect(cfg.logPath).toBe("./orca.log");
  });

  test("logMaxSizeMb defaults to 10", async () => {
    const cfg = await loadConfig();
    expect(cfg.logMaxSizeMb).toBe(10);
  });

  test("tunnelToken defaults to empty string", async () => {
    const cfg = await loadConfig();
    expect(cfg.tunnelToken).toBe("");
  });

  test("taskFilterLabel defaults to undefined", async () => {
    const cfg = await loadConfig();
    expect(cfg.taskFilterLabel).toBeUndefined();
  });

  test("githubWebhookSecret defaults to undefined", async () => {
    const cfg = await loadConfig();
    expect(cfg.githubWebhookSecret).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Custom values override defaults
// ---------------------------------------------------------------------------

describe("custom values override defaults", () => {
  test("ORCA_CONCURRENCY_CAP=5 → concurrencyCap: 5", async () => {
    process.env.ORCA_CONCURRENCY_CAP = "5";
    const cfg = await loadConfig();
    expect(cfg.concurrencyCap).toBe(5);
  });

  test("ORCA_CLAUDE_PATH=/usr/bin/claude → claudePath: '/usr/bin/claude'", async () => {
    process.env.ORCA_CLAUDE_PATH = "/usr/bin/claude";
    const cfg = await loadConfig();
    expect(cfg.claudePath).toBe("/usr/bin/claude");
  });

  test("ORCA_IMPLEMENT_MODEL=opus → implementModel: 'opus'", async () => {
    process.env.ORCA_IMPLEMENT_MODEL = "opus";
    const cfg = await loadConfig();
    expect(cfg.implementModel).toBe("opus");
  });

  test("ORCA_DEPLOY_STRATEGY=github_actions → deployStrategy: 'github_actions'", async () => {
    process.env.ORCA_DEPLOY_STRATEGY = "github_actions";
    const cfg = await loadConfig();
    expect(cfg.deployStrategy).toBe("github_actions");
  });
});

// ---------------------------------------------------------------------------
// Malformed values
// ---------------------------------------------------------------------------

describe("malformed values → exit(1)", () => {
  test("ORCA_CONCURRENCY_CAP=abc → exit(1)", async () => {
    process.env.ORCA_CONCURRENCY_CAP = "abc";
    await expect(loadConfig()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("ORCA_CONCURRENCY_CAP=0 → exit(1) (not positive)", async () => {
    process.env.ORCA_CONCURRENCY_CAP = "0";
    await expect(loadConfig()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("ORCA_CONCURRENCY_CAP=-1 → exit(1)", async () => {
    process.env.ORCA_CONCURRENCY_CAP = "-1";
    await expect(loadConfig()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("ORCA_CONCURRENCY_CAP=1.5 → exit(1) (not integer)", async () => {
    process.env.ORCA_CONCURRENCY_CAP = "1.5";
    await expect(loadConfig()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("ORCA_BUDGET_MAX_COST_USD=abc → exit(1)", async () => {
    process.env.ORCA_BUDGET_MAX_COST_USD = "abc";
    await expect(loadConfig()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("ORCA_DEPLOY_STRATEGY=invalid → exit(1)", async () => {
    process.env.ORCA_DEPLOY_STRATEGY = "invalid";
    await expect(loadConfig()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// Boolean parsing
// ---------------------------------------------------------------------------

describe("boolean parsing", () => {
  test("ORCA_RESUME_ON_MAX_TURNS=true → true", async () => {
    process.env.ORCA_RESUME_ON_MAX_TURNS = "true";
    const cfg = await loadConfig();
    expect(cfg.resumeOnMaxTurns).toBe(true);
  });

  test("ORCA_RESUME_ON_MAX_TURNS=1 → true", async () => {
    process.env.ORCA_RESUME_ON_MAX_TURNS = "1";
    const cfg = await loadConfig();
    expect(cfg.resumeOnMaxTurns).toBe(true);
  });

  test("ORCA_RESUME_ON_MAX_TURNS=false → false", async () => {
    process.env.ORCA_RESUME_ON_MAX_TURNS = "false";
    const cfg = await loadConfig();
    expect(cfg.resumeOnMaxTurns).toBe(false);
  });

  test("ORCA_RESUME_ON_MAX_TURNS=0 → false", async () => {
    process.env.ORCA_RESUME_ON_MAX_TURNS = "0";
    const cfg = await loadConfig();
    expect(cfg.resumeOnMaxTurns).toBe(false);
  });

  test("ORCA_RESUME_ON_MAX_TURNS=TRUE → true (case insensitive)", async () => {
    process.env.ORCA_RESUME_ON_MAX_TURNS = "TRUE";
    const cfg = await loadConfig();
    expect(cfg.resumeOnMaxTurns).toBe(true);
  });

  test("ORCA_RESUME_ON_MAX_TURNS=FALSE → false (case insensitive)", async () => {
    process.env.ORCA_RESUME_ON_MAX_TURNS = "FALSE";
    const cfg = await loadConfig();
    expect(cfg.resumeOnMaxTurns).toBe(false);
  });

  test("ORCA_RESUME_ON_MAX_TURNS=yes → exit(1)", async () => {
    process.env.ORCA_RESUME_ON_MAX_TURNS = "yes";
    await expect(loadConfig()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("ORCA_EXTERNAL_TUNNEL=true → true", async () => {
    process.env.ORCA_EXTERNAL_TUNNEL = "true";
    const cfg = await loadConfig();
    expect(cfg.externalTunnel).toBe(true);
  });

  test("ORCA_EXTERNAL_TUNNEL=false → false", async () => {
    process.env.ORCA_EXTERNAL_TUNNEL = "false";
    const cfg = await loadConfig();
    expect(cfg.externalTunnel).toBe(false);
  });

  test("ORCA_EXTERNAL_TUNNEL=yes → exit(1)", async () => {
    process.env.ORCA_EXTERNAL_TUNNEL = "yes";
    await expect(loadConfig()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// System prompt overrides
// ---------------------------------------------------------------------------

describe("system prompt overrides", () => {
  test("ORCA_IMPLEMENT_SYSTEM_PROMPT=custom → implementSystemPrompt: 'custom'", async () => {
    process.env.ORCA_IMPLEMENT_SYSTEM_PROMPT = "custom system prompt";
    const cfg = await loadConfig();
    expect(cfg.implementSystemPrompt).toBe("custom system prompt");
  });

  test("ORCA_APPEND_SYSTEM_PROMPT fallback when ORCA_IMPLEMENT_SYSTEM_PROMPT absent", async () => {
    delete process.env.ORCA_IMPLEMENT_SYSTEM_PROMPT;
    process.env.ORCA_APPEND_SYSTEM_PROMPT = "fallback prompt";
    const cfg = await loadConfig();
    expect(cfg.implementSystemPrompt).toBe("fallback prompt");
  });

  test("ORCA_IMPLEMENT_SYSTEM_PROMPT takes precedence over ORCA_APPEND_SYSTEM_PROMPT", async () => {
    process.env.ORCA_IMPLEMENT_SYSTEM_PROMPT = "primary prompt";
    process.env.ORCA_APPEND_SYSTEM_PROMPT = "fallback prompt";
    const cfg = await loadConfig();
    expect(cfg.implementSystemPrompt).toBe("primary prompt");
  });
});

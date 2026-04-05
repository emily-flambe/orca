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
  vi.spyOn(process, "exit").mockImplementation(
    (code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    },
  );

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
  test("all defaults are correct with minimal env", async () => {
    const cfg = await loadConfig();
    expect(cfg.concurrencyCap).toBe(1);
    expect(cfg.sessionTimeoutMin).toBe(45);
    expect(cfg.maxRetries).toBe(3);
    expect(cfg.budgetWindowHours).toBe(4);
    expect(cfg.budgetMaxTokens).toBe(1_000_000_000);
    expect(cfg.claudePath).toBe("claude");
    expect(cfg.defaultMaxTurns).toBe(50);
    expect(cfg.model).toBe("sonnet");
    expect(cfg.deployStrategy).toBe("none");
    expect(cfg.externalTunnel).toBe(false);
    expect(cfg.cloudflaredPath).toBe("cloudflared");
    expect(cfg.port).toBe(3000);
    expect(cfg.dbPath).toBe("./orca.db");
    expect(cfg.logPath).toBe("./orca.log");
    expect(cfg.tunnelToken).toBe("");
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

  test("ORCA_IMPLEMENT_MODEL=opus → model: 'opus'", async () => {
    process.env.ORCA_IMPLEMENT_MODEL = "opus";
    const cfg = await loadConfig();
    expect(cfg.model).toBe("opus");
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
  test("ORCA_CONCURRENCY_CAP=abc → exit(1) (non-number)", async () => {
    process.env.ORCA_CONCURRENCY_CAP = "abc";
    await expect(loadConfig()).rejects.toThrow("process.exit(1)");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("ORCA_CONCURRENCY_CAP=0 → exit(1) (not positive)", async () => {
    process.env.ORCA_CONCURRENCY_CAP = "0";
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
// ORCA_STATE_MAP
// ---------------------------------------------------------------------------

// ORCA_STATE_MAP was removed — stateMapOverrides no longer exists in OrcaConfig.

// ---------------------------------------------------------------------------
// System prompt overrides
// ---------------------------------------------------------------------------

describe("system prompt overrides", () => {
  test("ORCA_IMPLEMENT_SYSTEM_PROMPT=custom → implementSystemPrompt: 'custom'", async () => {
    process.env.ORCA_IMPLEMENT_SYSTEM_PROMPT = "custom system prompt";
    const cfg = await loadConfig();
    expect(cfg.implementSystemPrompt).toBe("custom system prompt");
  });

  test("uses default implement system prompt when ORCA_IMPLEMENT_SYSTEM_PROMPT absent", async () => {
    delete process.env.ORCA_IMPLEMENT_SYSTEM_PROMPT;
    const cfg = await loadConfig();
    expect(cfg.implementSystemPrompt).toContain("autonomous coding agent");
  });
});

// ---------------------------------------------------------------------------
// GITHUB_MCP_PAT
// ---------------------------------------------------------------------------

describe("GITHUB_MCP_PAT", () => {
  test("not set → githubMcpPat is undefined", async () => {
    delete process.env.GITHUB_MCP_PAT;
    const cfg = await loadConfig();
    expect(cfg.githubMcpPat).toBeUndefined();
  });

  test("set → githubMcpPat is the token value", async () => {
    process.env.GITHUB_MCP_PAT = "ghp_test1234";
    const cfg = await loadConfig();
    expect(cfg.githubMcpPat).toBe("ghp_test1234");
  });
});

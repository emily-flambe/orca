// ---------------------------------------------------------------------------
// Tests for src/hooks.ts, src/hooks-store.ts, and hook API endpoints.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeHookConfig, cleanHookConfig } from "../src/hooks.js";
import {
  hookEventStore,
  recordHookEvent,
  getHookEvents,
  clearHookEvents,
} from "../src/hooks-store.js";
import { createDb } from "../src/db/index.js";
import { createApiRoutes } from "../src/api/routes.js";
import type { OrcaConfig } from "../src/config/index.js";
import type { OrcaDb } from "../src/db/index.js";
import type { Hono } from "hono";

vi.mock("../src/deploy.js", () => ({
  isDraining: vi.fn().mockReturnValue(false),
  setDraining: vi.fn(),
  initDeployState: vi.fn(),
}));

const mockInngest = { send: vi.fn().mockResolvedValue(undefined) } as any;

function makeConfig(overrides?: Partial<OrcaConfig>): OrcaConfig {
  return {
    defaultCwd: "/tmp",
    concurrencyCap: 3,
    sessionTimeoutMin: 45,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxTokens: 100000,
    claudePath: "claude",
    defaultMaxTurns: 20,
    implementSystemPrompt: "",
    reviewSystemPrompt: "",
    fixSystemPrompt: "",
    maxReviewCycles: 3,
    reviewMaxTurns: 30,
    disallowedTools: "",
    model: "sonnet",
    reviewModel: "haiku",
    port: 4000,
    dbPath: ":memory:",
    logPath: "",
    linearApiKey: "test",
    linearWebhookSecret: "test",
    linearProjectIds: ["test-project"],
    tunnelHostname: "test.example.com",
    projectRepoMap: new Map(),
    deployStrategy: "none",
    maxDeployPollAttempts: 10,
    maxCiPollAttempts: 10,
    alertWebhookUrl: undefined,
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    externalTunnel: false,
    logLevel: "info",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// writeHookConfig: basic behavior
// ---------------------------------------------------------------------------
describe("writeHookConfig", () => {
  let worktreePath: string;

  beforeEach(() => {
    worktreePath = join(tmpdir(), `hooks-test-${Date.now()}`);
    mkdirSync(worktreePath, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("creates .claude/settings.local.json with Notification and Stop hooks", () => {
    writeHookConfig(worktreePath, 42, 4000);
    const settingsPath = join(worktreePath, ".claude", "settings.local.json");
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks.Notification).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Notification[0].hooks[0].command).toContain(
      "http://localhost:4000/api/hooks/42",
    );
  });

  it("hook command contains correct invocationId and port", () => {
    writeHookConfig(worktreePath, 99, 4001);
    const settingsPath = join(worktreePath, ".claude", "settings.local.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const cmd: string = settings.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain("localhost:4001/api/hooks/99");
  });

  it("worktree path with spaces does not corrupt the curl command", () => {
    const spacedPath = join(tmpdir(), "path with spaces");
    mkdirSync(join(spacedPath, ".claude"), { recursive: true });
    try {
      writeHookConfig(spacedPath, 7, 4000);
      const settings = JSON.parse(
        readFileSync(
          join(spacedPath, ".claude", "settings.local.json"),
          "utf-8",
        ),
      );
      const cmd: string = settings.hooks.Notification[0].hooks[0].command;
      expect(cmd).toContain("http://localhost:4000/api/hooks/7");
      // Worktree path must not appear in the command (only the URL matters)
      expect(cmd).not.toContain(spacedPath);
    } finally {
      rmSync(spacedPath, { recursive: true, force: true });
    }
  });

  it("merges with pre-existing settings.local.json — preserves existing hooks", () => {
    const existingSettings = {
      permissions: { allow: ["Bash", "Read"] },
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo pre" }],
          },
        ],
      },
    };
    const settingsPath = join(worktreePath, ".claude", "settings.local.json");
    mkdirSync(join(worktreePath, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(existingSettings), "utf-8");

    writeHookConfig(worktreePath, 42, 4000);

    const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
    // Existing permissions are preserved
    expect(written.permissions).toEqual({ allow: ["Bash", "Read"] });
    // Existing PreToolUse hook is preserved
    expect(written.hooks.PreToolUse).toHaveLength(1);
    // Orca's hooks are added
    expect(written.hooks.Notification).toHaveLength(1);
    expect(written.hooks.Stop).toHaveLength(1);
  });

  it("appends to existing Notification/Stop hooks rather than replacing them", () => {
    const existing = {
      hooks: {
        Notification: [
          { matcher: "", hooks: [{ type: "command", command: "echo notify" }] },
        ],
        Stop: [
          { matcher: "", hooks: [{ type: "command", command: "echo stop" }] },
        ],
      },
    };
    const settingsPath = join(worktreePath, ".claude", "settings.local.json");
    mkdirSync(join(worktreePath, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(existing), "utf-8");

    writeHookConfig(worktreePath, 1, 4000);

    const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
    // Orca's hook prepended + existing hook preserved
    expect(written.hooks.Notification).toHaveLength(2);
    expect(written.hooks.Stop).toHaveLength(2);
    // Orca's hook is first
    expect(written.hooks.Notification[0].hooks[0].command).toContain(
      "localhost:4000",
    );
    // Existing hook preserved
    expect(written.hooks.Notification[1].hooks[0].command).toBe("echo notify");
  });
});

// ---------------------------------------------------------------------------
// cleanHookConfig
// ---------------------------------------------------------------------------
describe("cleanHookConfig", () => {
  let worktreePath: string;

  beforeEach(() => {
    worktreePath = join(tmpdir(), `hooks-clean-test-${Date.now()}`);
    mkdirSync(worktreePath, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("removes settings.local.json", () => {
    writeHookConfig(worktreePath, 1, 4000);
    const settingsPath = join(worktreePath, ".claude", "settings.local.json");
    expect(existsSync(settingsPath)).toBe(true);
    cleanHookConfig(worktreePath);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it("removes .claude directory if it was empty after removing the settings file", () => {
    const claudeDir = join(worktreePath, ".claude");
    expect(existsSync(claudeDir)).toBe(false);

    writeHookConfig(worktreePath, 99, 4000);
    expect(existsSync(claudeDir)).toBe(true);

    cleanHookConfig(worktreePath);
    expect(existsSync(claudeDir)).toBe(false);
  });

  it("leaves .claude directory if other files exist inside it", () => {
    const claudeDir = join(worktreePath, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    // Write another file in .claude so directory is non-empty after cleanup
    writeFileSync(join(claudeDir, "other.json"), "{}", "utf-8");

    writeHookConfig(worktreePath, 1, 4000);
    cleanHookConfig(worktreePath);

    // .claude still exists (non-empty)
    expect(existsSync(claudeDir)).toBe(true);
    // settings.local.json is gone
    expect(existsSync(join(claudeDir, "settings.local.json"))).toBe(false);
    // other.json preserved
    expect(existsSync(join(claudeDir, "other.json"))).toBe(true);
  });

  it("is a no-op when settings.local.json does not exist", () => {
    // Should not throw
    expect(() => cleanHookConfig(worktreePath)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// hookEventStore
// ---------------------------------------------------------------------------
describe("hookEventStore", () => {
  beforeEach(() => {
    hookEventStore.clear();
  });

  afterEach(() => {
    hookEventStore.clear();
  });

  it("stores events and retrieves them by invocationId", () => {
    recordHookEvent(1, { type: "Notification", message: "hello" });
    recordHookEvent(1, { type: "Stop" });
    const events = getHookEvents(1);
    expect(events).toHaveLength(2);
    expect(events[0].invocationId).toBe(1);
  });

  it("caps events at 200 per invocation", () => {
    for (let i = 0; i < 250; i++) {
      recordHookEvent(1, { i });
    }
    expect(getHookEvents(1)).toHaveLength(200);
  });

  it("getHookEvents returns empty array for unknown invocationId", () => {
    expect(getHookEvents(9999)).toEqual([]);
  });

  it("clearHookEvents removes all events for an invocation", () => {
    recordHookEvent(5, { type: "Stop" });
    expect(getHookEvents(5)).toHaveLength(1);
    clearHookEvents(5);
    expect(getHookEvents(5)).toEqual([]);
    expect(hookEventStore.has(5)).toBe(false);
  });

  it("evicts oldest entry when store exceeds 500 invocations", () => {
    // Fill to capacity
    for (let i = 1; i <= 500; i++) {
      recordHookEvent(i, { type: "Notification" });
    }
    expect(hookEventStore.size).toBe(500);

    // Adding one more should evict the oldest (invocation 1)
    recordHookEvent(501, { type: "Stop" });
    expect(hookEventStore.size).toBe(500);
    expect(hookEventStore.has(1)).toBe(false);
    expect(hookEventStore.has(501)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hook API endpoints
// ---------------------------------------------------------------------------
describe("POST /api/hooks/:invocationId", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    hookEventStore.clear();
    db = createDb(":memory:");
    app = createApiRoutes({
      db,
      config: makeConfig(),
      syncTasks: vi.fn().mockResolvedValue(0),
      client: {} as any,
      stateMap: new Map(),
      projectMeta: [],
      inngest: mockInngest,
    });
  });

  afterEach(() => {
    hookEventStore.clear();
  });

  it("returns 200 and stores the event", async () => {
    const res = await app.request("/api/hooks/1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "Notification", message: "hi" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(getHookEvents(1)).toHaveLength(1);
  });

  it("returns 400 for invocationId=0", async () => {
    const res = await app.request("/api/hooks/0", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "Stop" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for negative invocationId", async () => {
    const res = await app.request("/api/hooks/-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "Stop" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-numeric invocationId", async () => {
    const res = await app.request("/api/hooks/abc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "Stop" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await app.request("/api/hooks/1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/hooks/:invocationId", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    hookEventStore.clear();
    db = createDb(":memory:");
    app = createApiRoutes({
      db,
      config: makeConfig(),
      syncTasks: vi.fn().mockResolvedValue(0),
      client: {} as any,
      stateMap: new Map(),
      projectMeta: [],
      inngest: mockInngest,
    });
  });

  afterEach(() => {
    hookEventStore.clear();
  });

  it("returns events for an invocation", async () => {
    recordHookEvent(7, { type: "Stop" });
    const res = await app.request("/api/hooks/7");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toHaveLength(1);
  });

  it("returns empty events array for unknown invocationId", async () => {
    const res = await app.request("/api/hooks/9999");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toEqual([]);
  });

  it("returns 400 for invocationId=0", async () => {
    const res = await app.request("/api/hooks/0");
    expect(res.status).toBe(400);
  });
});

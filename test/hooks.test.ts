// ---------------------------------------------------------------------------
// Claude Code hooks integration tests
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHookConfig } from "../src/worktree/index.js";
import { invocationLogs } from "../src/runner/index.js";
import { EventEmitter } from "node:events";

vi.mock("../src/deploy.js", () => ({
  isDraining: vi.fn().mockReturnValue(false),
  getDrainingForSeconds: vi.fn().mockReturnValue(null),
  setDraining: vi.fn(),
  initDeployState: vi.fn(),
}));

describe("writeHookConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-hook-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates .claude/settings.local.json with hook config", () => {
    writeHookConfig(tmpDir, "http://localhost:4000/api/hooks/42");
    const settingsPath = join(tmpDir, ".claude", "settings.local.json");
    expect(existsSync(settingsPath)).toBe(true);
    const config = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(config.hooks).toBeDefined();
    expect(config.hooks.Notification).toBeInstanceOf(Array);
    expect(config.hooks.Stop).toBeInstanceOf(Array);
    const notifHook = config.hooks.Notification[0].hooks[0];
    expect(notifHook.type).toBe("command");
    expect(notifHook.command).toContain("http://localhost:4000/api/hooks/42");
    expect(notifHook.command).toContain("curl");
  });

  it("creates .claude directory if it does not exist", () => {
    writeHookConfig(tmpDir, "http://localhost:4000/api/hooks/1");
    expect(existsSync(join(tmpDir, ".claude"))).toBe(true);
  });

  it("overwrites existing settings.local.json", () => {
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".claude", "settings.local.json"),
      '{"old": true}',
    );
    writeHookConfig(tmpDir, "http://localhost:4000/api/hooks/99");
    const config = JSON.parse(
      readFileSync(join(tmpDir, ".claude", "settings.local.json"), "utf8"),
    );
    expect(config.hooks).toBeDefined();
    expect((config as Record<string, unknown>).old).toBeUndefined();
  });
});

describe("POST /api/hooks/:invocationId", () => {
  beforeEach(() => {
    invocationLogs.clear();
  });

  it("appends hook_event to invocation log state", async () => {
    const logState = {
      buffer: [] as string[],
      emitter: new EventEmitter(),
      done: false,
    };
    invocationLogs.set(7, logState);

    const { createApiRoutes } = await import("../src/api/routes.js");
    const { createDb } = await import("../src/db/index.js");
    const db = createDb(":memory:");
    const config = {
      port: 4000,
      concurrencyCap: 1,
      agentConcurrencyCap: 12,
      sessionTimeoutMin: 45,
      maxRetries: 3,
      budgetWindowHours: 4,
      budgetMaxTokens: 1e9,
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
      deployStrategy: "none" as const,
      maxDeployPollAttempts: 60,
      maxCiPollAttempts: 240,
      dbPath: ":memory:",
      logPath: "/tmp/test.log",
      linearApiKey: "test",
      linearWebhookSecret: "test",
      linearProjectIds: [],
      tunnelHostname: "",
      tunnelToken: "",
      cloudflaredPath: "cloudflared",
      externalTunnel: false,
      logLevel: "info" as const,
      defaultCwd: "/tmp",
      projectRepoMap: new Map(),
      alertWebhookUrl: undefined,
    };
    const mockInngest = { send: vi.fn() } as any;
    const app = createApiRoutes({
      db,
      config,
      syncTasks: vi.fn().mockResolvedValue(0),
      client: {} as any,
      stateMap: new Map(),
      projectMeta: [],
      inngest: mockInngest,
    });

    const payload = { hook_event_type: "Notification", message: "test" };
    const res = await app.request("/api/hooks/7", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    expect(logState.buffer.length).toBe(1);
    const entry = JSON.parse(logState.buffer[0]);
    expect(entry.type).toBe("hook_event");
    expect(entry.data).toEqual(payload);
  });

  it("returns 200 even if invocation is not in memory (already completed)", async () => {
    const { createApiRoutes } = await import("../src/api/routes.js");
    const { createDb } = await import("../src/db/index.js");
    const db = createDb(":memory:");
    const config = {
      port: 4000,
      concurrencyCap: 1,
      agentConcurrencyCap: 12,
      sessionTimeoutMin: 45,
      maxRetries: 3,
      budgetWindowHours: 4,
      budgetMaxTokens: 1e9,
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
      deployStrategy: "none" as const,
      maxDeployPollAttempts: 60,
      maxCiPollAttempts: 240,
      dbPath: ":memory:",
      logPath: "/tmp/test.log",
      linearApiKey: "test",
      linearWebhookSecret: "test",
      linearProjectIds: [],
      tunnelHostname: "",
      tunnelToken: "",
      cloudflaredPath: "cloudflared",
      externalTunnel: false,
      logLevel: "info" as const,
      defaultCwd: "/tmp",
      projectRepoMap: new Map(),
      alertWebhookUrl: undefined,
    };
    const mockInngest = { send: vi.fn() } as any;
    const app = createApiRoutes({
      db,
      config,
      syncTasks: vi.fn().mockResolvedValue(0),
      client: {} as any,
      stateMap: new Map(),
      projectMeta: [],
      inngest: mockInngest,
    });

    const res = await app.request("/api/hooks/9999", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "Notification" }),
    });

    expect(res.status).toBe(200);
  });

  it("returns 400 for invalid JSON body", async () => {
    const { createApiRoutes } = await import("../src/api/routes.js");
    const { createDb } = await import("../src/db/index.js");
    const db = createDb(":memory:");
    const config = {
      port: 4000,
      concurrencyCap: 1,
      agentConcurrencyCap: 12,
      sessionTimeoutMin: 45,
      maxRetries: 3,
      budgetWindowHours: 4,
      budgetMaxTokens: 1e9,
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
      deployStrategy: "none" as const,
      maxDeployPollAttempts: 60,
      maxCiPollAttempts: 240,
      dbPath: ":memory:",
      logPath: "/tmp/test.log",
      linearApiKey: "test",
      linearWebhookSecret: "test",
      linearProjectIds: [],
      tunnelHostname: "",
      tunnelToken: "",
      cloudflaredPath: "cloudflared",
      externalTunnel: false,
      logLevel: "info" as const,
      defaultCwd: "/tmp",
      projectRepoMap: new Map(),
      alertWebhookUrl: undefined,
    };
    const mockInngest = { send: vi.fn() } as any;
    const app = createApiRoutes({
      db,
      config,
      syncTasks: vi.fn().mockResolvedValue(0),
      client: {} as any,
      stateMap: new Map(),
      projectMeta: [],
      inngest: mockInngest,
    });

    const res = await app.request("/api/hooks/5", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });

    expect(res.status).toBe(400);
  });
});

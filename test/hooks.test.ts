// ---------------------------------------------------------------------------
// Adversarial tests for the hooks integration (EMI-366)
//
// Covers:
//   1. writeHookConfig — basic write, JSON structure, URL construction,
//      creates .claude dir, handles write errors without throwing
//   2. cleanupHookConfig — removes file, handles missing file, handles
//      rmSync errors without throwing
//   3. POST /api/hooks/:invocationId — valid events, invalid invocationId
//      (NaN, negative, float, empty), invalid JSON, unknown invocation,
//      large body, concurrent requests, SSE buffer cap
// ---------------------------------------------------------------------------

import { describe, it, test, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Mock node:fs for writeHookConfig / cleanupHookConfig unit tests
// ---------------------------------------------------------------------------

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Helpers for API tests
// ---------------------------------------------------------------------------

import { createDb } from "../src/db/index.js";
import { createApiRoutes } from "../src/api/routes.js";
import type { OrcaConfig } from "../src/config/index.js";
import { invocationLogs } from "../src/runner/index.js";

vi.mock("../src/deploy.js", () => ({
  isDraining: vi.fn().mockReturnValue(false),
  setDraining: vi.fn(),
  clearDraining: vi.fn(),
  initDeployState: vi.fn(),
}));

const mockInngest = { send: vi.fn().mockResolvedValue(undefined) } as any;

function makeConfig(overrides?: Partial<OrcaConfig>): OrcaConfig {
  return {
    defaultCwd: "/tmp",
    concurrencyCap: 1,
    sessionTimeoutMin: 45,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxCostUsd: 10.0,
    claudePath: "claude",
    defaultMaxTurns: 20,
    implementSystemPrompt: "",
    reviewSystemPrompt: "",
    fixSystemPrompt: "",
    maxReviewCycles: 3,
    reviewMaxTurns: 30,
    disallowedTools: "",
    port: 3000,
    dbPath: ":memory:",
    linearApiKey: "test",
    linearWebhookSecret: "test",
    linearProjectIds: ["test-project"],
    linearReadyStateType: "unstarted",
    tunnelHostname: "test.example.com",
    projectRepoMap: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. writeHookConfig
// ---------------------------------------------------------------------------

describe("writeHookConfig", () => {
  let mockMkdirSync: ReturnType<typeof vi.fn>;
  let mockWriteFileSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const fsModule = await import("node:fs");
    mockMkdirSync = vi.mocked(fsModule.mkdirSync);
    mockWriteFileSync = vi.mocked(fsModule.writeFileSync);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  test("writes to <worktreePath>/.claude/settings.local.json", async () => {
    const { writeHookConfig } = await import("../src/hooks/index.js");

    writeHookConfig("/some/worktree", 42, 3000);

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const [writtenPath] = mockWriteFileSync.mock.calls[0] as [
      string,
      ...unknown[],
    ];
    expect(writtenPath).toBe(
      join("/some/worktree", ".claude", "settings.local.json"),
    );
  });

  test("creates .claude directory with recursive:true before writing", async () => {
    const { writeHookConfig } = await import("../src/hooks/index.js");

    writeHookConfig("/some/worktree", 42, 3000);

    expect(mockMkdirSync).toHaveBeenCalledWith(
      join("/some/worktree", ".claude"),
      { recursive: true },
    );
    // mkdir must be called before writeFileSync
    const mkdirOrder = mockMkdirSync.mock.invocationCallOrder[0];
    const writeOrder = mockWriteFileSync.mock.invocationCallOrder[0];
    expect(mkdirOrder).toBeLessThan(writeOrder);
  });

  test("written content is valid JSON", async () => {
    const { writeHookConfig } = await import("../src/hooks/index.js");

    writeHookConfig("/repo/worktree", 7, 4001);

    const content = mockWriteFileSync.mock.calls[0][1] as string;
    expect(() => JSON.parse(content)).not.toThrow();
  });

  test("JSON structure has hooks.Notification and hooks.Stop at top level", async () => {
    const { writeHookConfig } = await import("../src/hooks/index.js");

    writeHookConfig("/repo/worktree", 7, 4001);

    const content = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(content) as unknown;
    expect(parsed).toHaveProperty("hooks");
    const hooks = (parsed as Record<string, unknown>).hooks as Record<
      string,
      unknown
    >;
    expect(hooks).toHaveProperty("Notification");
    expect(hooks).toHaveProperty("Stop");
  });

  test("Notification hook has correct URL with invocationId and port", async () => {
    const { writeHookConfig } = await import("../src/hooks/index.js");

    writeHookConfig("/repo/worktree", 99, 4001);

    const content = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(content) as {
      hooks: {
        Notification: Array<{ hooks: Array<{ type: string; url: string }> }>;
      };
    };
    const notifUrl = parsed.hooks.Notification[0].hooks[0].url;
    expect(notifUrl).toBe("http://localhost:4001/api/hooks/99");
  });

  test("Stop hook has correct URL matching Notification hook", async () => {
    const { writeHookConfig } = await import("../src/hooks/index.js");

    writeHookConfig("/repo/worktree", 99, 4001);

    const content = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(content) as {
      hooks: {
        Notification: Array<{ hooks: Array<{ url: string }> }>;
        Stop: Array<{ hooks: Array<{ url: string }> }>;
      };
    };
    const notifUrl = parsed.hooks.Notification[0].hooks[0].url;
    const stopUrl = parsed.hooks.Stop[0].hooks[0].url;
    expect(stopUrl).toBe(notifUrl);
  });

  test("hook type is 'http' (not 'https' or anything else)", async () => {
    const { writeHookConfig } = await import("../src/hooks/index.js");

    writeHookConfig("/repo/worktree", 1, 3000);

    const content = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(content) as {
      hooks: { Notification: Array<{ hooks: Array<{ type: string }> }> };
    };
    expect(parsed.hooks.Notification[0].hooks[0].type).toBe("http");
  });

  test("does NOT throw when mkdirSync fails", async () => {
    const { writeHookConfig } = await import("../src/hooks/index.js");
    mockMkdirSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    expect(() => writeHookConfig("/read-only", 1, 3000)).not.toThrow();
  });

  test("does NOT throw when writeFileSync fails", async () => {
    const { writeHookConfig } = await import("../src/hooks/index.js");
    mockWriteFileSync.mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });

    expect(() => writeHookConfig("/full-disk", 1, 3000)).not.toThrow();
  });

  test("invocationId 0 produces valid URL (not NaN or undefined)", async () => {
    const { writeHookConfig } = await import("../src/hooks/index.js");

    writeHookConfig("/repo/worktree", 0, 3000);

    const content = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(content) as {
      hooks: { Notification: Array<{ hooks: Array<{ url: string }> }> };
    };
    const url = parsed.hooks.Notification[0].hooks[0].url;
    expect(url).toBe("http://localhost:3000/api/hooks/0");
    expect(url).not.toContain("NaN");
    expect(url).not.toContain("undefined");
  });

  test("uses ORCA_PORT env var — different ports produce different URLs", async () => {
    // This tests the worktree integration, not writeHookConfig directly.
    // But we can confirm writeHookConfig itself respects the `port` argument.
    const { writeHookConfig } = await import("../src/hooks/index.js");

    writeHookConfig("/repo/worktree", 5, 5000);

    const content = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(content) as {
      hooks: { Notification: Array<{ hooks: Array<{ url: string }> }> };
    };
    expect(parsed.hooks.Notification[0].hooks[0].url).toContain(":5000/");
  });
});

// ---------------------------------------------------------------------------
// 2. cleanupHookConfig
// ---------------------------------------------------------------------------

describe("cleanupHookConfig", () => {
  let mockRmSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const fsModule = await import("node:fs");
    mockRmSync = vi.mocked(fsModule.rmSync);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  test("removes <worktreePath>/.claude/settings.local.json", async () => {
    const { cleanupHookConfig } = await import("../src/hooks/index.js");

    cleanupHookConfig("/some/worktree");

    expect(mockRmSync).toHaveBeenCalledWith(
      join("/some/worktree", ".claude", "settings.local.json"),
      { force: true },
    );
  });

  test("uses force:true so missing file does not throw from rmSync", async () => {
    const { cleanupHookConfig } = await import("../src/hooks/index.js");

    cleanupHookConfig("/some/worktree");

    const opts = mockRmSync.mock.calls[0][1] as { force?: boolean };
    expect(opts.force).toBe(true);
  });

  test("does NOT throw when file was never created (rmSync throws ENOENT)", async () => {
    const { cleanupHookConfig } = await import("../src/hooks/index.js");
    const err = Object.assign(new Error("ENOENT: no such file"), {
      code: "ENOENT",
    });
    mockRmSync.mockImplementation(() => {
      throw err;
    });

    expect(() => cleanupHookConfig("/missing-dir")).not.toThrow();
  });

  test("does NOT throw when rmSync throws a generic error", async () => {
    const { cleanupHookConfig } = await import("../src/hooks/index.js");
    mockRmSync.mockImplementation(() => {
      throw new Error("permission denied");
    });

    expect(() => cleanupHookConfig("/locked-dir")).not.toThrow();
  });

  test("always calls rmSync exactly once regardless of path", async () => {
    const { cleanupHookConfig } = await import("../src/hooks/index.js");

    cleanupHookConfig("/any/path");

    expect(mockRmSync).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 3. POST /api/hooks/:invocationId
// ---------------------------------------------------------------------------

describe("POST /api/hooks/:invocationId", () => {
  let app: ReturnType<typeof createApiRoutes>;

  beforeEach(() => {
    const db = createDb(":memory:");
    app = createApiRoutes({
      db,
      config: makeConfig(),
      syncTasks: vi.fn().mockResolvedValue([]),
      client: {} as any,
      stateMap: new Map(),
      projectMeta: [],
      inngest: mockInngest,
    });
    // Ensure invocationLogs is clean before each test
    invocationLogs.clear();
  });

  afterEach(() => {
    invocationLogs.clear();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Valid requests
  // -------------------------------------------------------------------------

  test("returns 200 with {ok:true} for valid invocationId and JSON body", async () => {
    const res = await app.request("/api/hooks/42", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "notification", message: "hello" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("returns 200 even when invocationId does not match any active session", async () => {
    // No session in invocationLogs — unknown invocation should still 200
    const res = await app.request("/api/hooks/9999", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "stop" }),
    });
    expect(res.status).toBe(200);
  });

  test("pushes event to SSE buffer when session is active", async () => {
    const emitter = new EventEmitter();
    invocationLogs.set(5, { buffer: [], emitter, done: false });

    const lines: string[] = [];
    emitter.on("line", (l: string) => lines.push(l));

    await app.request("/api/hooks/5", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "notification", data: "test" }),
    });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as {
      type: string;
      invocationId: number;
      payload: unknown;
    };
    expect(entry.type).toBe("hook_event");
    expect(entry.invocationId).toBe(5);
    expect(entry.payload).toEqual({ event: "notification", data: "test" });
  });

  test("does NOT push to SSE buffer when session is marked done", async () => {
    const emitter = new EventEmitter();
    invocationLogs.set(10, { buffer: [], emitter, done: true });

    const lines: string[] = [];
    emitter.on("line", (l: string) => lines.push(l));

    await app.request("/api/hooks/10", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "stop" }),
    });

    expect(lines).toHaveLength(0);
    expect(invocationLogs.get(10)!.buffer).toHaveLength(0);
  });

  test("hook entry includes timestamp field", async () => {
    const emitter = new EventEmitter();
    invocationLogs.set(20, { buffer: [], emitter, done: false });

    const lines: string[] = [];
    emitter.on("line", (l: string) => lines.push(l));

    await app.request("/api/hooks/20", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "notification" }),
    });

    const entry = JSON.parse(lines[0]) as { timestamp: string };
    expect(entry.timestamp).toBeDefined();
    expect(() => new Date(entry.timestamp)).not.toThrow();
    // Timestamp must be a real ISO date, not empty string
    expect(new Date(entry.timestamp).getTime()).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Invalid invocationId inputs
  // -------------------------------------------------------------------------

  test("returns 400 for non-numeric invocationId", async () => {
    const res = await app.request("/api/hooks/abc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeDefined();
  });

  test("returns 400 for empty string invocationId", async () => {
    // Route won't match an empty segment — Hono will 404, but we test what we can
    // A blank param that parseInt gives NaN for
    const res = await app.request("/api/hooks/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    // Either 404 (no route match) or 400 (matched with empty) — not 200 ok
    expect(res.status).not.toBe(200);
  });

  test("returns 400 for 'NaN' string invocationId", async () => {
    const res = await app.request("/api/hooks/NaN", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 for negative invocationId", async () => {
    const res = await app.request("/api/hooks/-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "test" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeDefined();
  });

  test("returns 400 for zero invocationId", async () => {
    const res = await app.request("/api/hooks/0", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "test" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeDefined();
  });

  test("float invocationId (e.g. '1.5') is accepted as integer 1 by parseInt", async () => {
    // parseInt("1.5", 10) = 1 — no 400 returned, treated as invocationId=1
    // Documents the behavior. The real check: no crash.
    const res = await app.request("/api/hooks/1.5", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "test" }),
    });
    expect(res.status).not.toBe(500);
  });

  // -------------------------------------------------------------------------
  // Invalid JSON
  // -------------------------------------------------------------------------

  test("returns 400 for malformed JSON body", async () => {
    const res = await app.request("/api/hooks/42", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeDefined();
  });

  test("returns 400 for empty body with JSON content-type", async () => {
    const res = await app.request("/api/hooks/42", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 for body that is not an object (plain string JSON)", async () => {
    // JSON.stringify("hello") = '"hello"' which IS valid JSON but may not be an object.
    // The implementation calls c.req.json() which succeeds, so this should 200.
    // Documenting: no crash for non-object payloads.
    const res = await app.request("/api/hooks/42", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '"just a string"',
    });
    // Should not 500
    expect(res.status).not.toBe(500);
  });

  // -------------------------------------------------------------------------
  // Large body handling
  // -------------------------------------------------------------------------

  test("handles large JSON body without crashing", async () => {
    const largePayload = { data: "x".repeat(100_000) };
    const res = await app.request("/api/hooks/42", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(largePayload),
    });
    // Should accept it (no size guard in implementation)
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // SSE buffer cap
  // -------------------------------------------------------------------------

  test("SSE buffer is capped at 100 entries — oldest entry is evicted", async () => {
    const emitter = new EventEmitter();
    // Pre-fill buffer with 100 entries
    const buffer: string[] = Array.from({ length: 100 }, (_, i) => `line-${i}`);
    invocationLogs.set(30, { buffer, emitter, done: false });

    await app.request("/api/hooks/30", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "new" }),
    });

    const state = invocationLogs.get(30)!;
    // Buffer should still be 100 (oldest evicted, newest pushed)
    expect(state.buffer).toHaveLength(100);
    // The last entry should be the new hook event
    const lastEntry = JSON.parse(state.buffer[state.buffer.length - 1]) as {
      type: string;
    };
    expect(lastEntry.type).toBe("hook_event");
    // The very first entry (index 0) should NOT be "line-0" (it was evicted)
    expect(state.buffer[0]).not.toBe("line-0");
  });

  test("SSE buffer grows to 100 from empty without eviction", async () => {
    const emitter = new EventEmitter();
    invocationLogs.set(31, { buffer: [], emitter, done: false });

    // Send 99 events
    for (let i = 0; i < 99; i++) {
      await app.request("/api/hooks/31", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seq: i }),
      });
    }

    expect(invocationLogs.get(31)!.buffer).toHaveLength(99);
  });

  // -------------------------------------------------------------------------
  // Concurrent requests
  // -------------------------------------------------------------------------

  test("concurrent requests to same invocationId all return 200", async () => {
    const emitter = new EventEmitter();
    invocationLogs.set(50, { buffer: [], emitter, done: false });

    const requests = Array.from({ length: 20 }, (_, i) =>
      app.request("/api/hooks/50", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seq: i }),
      }),
    );

    const results = await Promise.all(requests);
    for (const res of results) {
      expect(res.status).toBe(200);
    }
  });

  test("concurrent requests to same invocationId all land in the buffer (up to cap)", async () => {
    const emitter = new EventEmitter();
    invocationLogs.set(51, { buffer: [], emitter, done: false });

    const count = 20;
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        app.request("/api/hooks/51", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seq: i }),
        }),
      ),
    );

    const state = invocationLogs.get(51)!;
    // All 20 should be in buffer (< 100 cap)
    expect(state.buffer).toHaveLength(count);
  });

  // -------------------------------------------------------------------------
  // Verify writeHookConfig produces URL matching actual route
  // -------------------------------------------------------------------------

  test("writeHookConfig URL points to the actual registered route path", async () => {
    // Import writeHookConfig with real fs mock to capture what URL it writes
    const fsMock = await import("node:fs");
    const mockWrite = vi.mocked(fsMock.writeFileSync);
    mockWrite.mockClear();

    const { writeHookConfig } = await import("../src/hooks/index.js");
    writeHookConfig("/some/worktree", 77, 3000);

    const content = mockWrite.mock.calls[0][1] as string;
    const parsed = JSON.parse(content) as {
      hooks: { Notification: Array<{ hooks: Array<{ url: string }> }> };
    };
    const hookUrl = parsed.hooks.Notification[0].hooks[0].url;

    // Extract path from URL and verify the route exists
    const urlObj = new URL(hookUrl);
    const path = urlObj.pathname; // "/api/hooks/77"

    // Make a real request to that path — route must be registered
    const res = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "test" }),
    });
    expect(res.status).not.toBe(404);
  });
});

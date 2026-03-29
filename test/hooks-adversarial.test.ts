// ---------------------------------------------------------------------------
// Adversarial tests for Claude Code hooks integration
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHookConfig } from "../src/worktree/index.js";
import { invocationLogs } from "../src/runner/index.js";
import { EventEmitter } from "node:events";
import { createDb } from "../src/db/index.js";
import {
  insertHookEvent,
  getHookEventsByInvocation,
} from "../src/db/queries.js";
import { getOrcaPort, getHookUrl } from "../src/hooks.js";

vi.mock("../src/deploy.js", () => ({
  isDraining: vi.fn().mockReturnValue(false),
  getDrainingSeconds: vi.fn().mockReturnValue(null),
  setDraining: vi.fn(),
  clearDraining: vi.fn(),
  initDeployState: vi.fn(),
  getDrainingForSeconds: vi.fn().mockReturnValue(null),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig() {
  return {
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
}

async function makeApp() {
  const { createApiRoutes } = await import("../src/api/routes.js");
  const db = createDb(":memory:");
  const mockInngest = { send: vi.fn() } as any;
  const app = createApiRoutes({
    db,
    config: makeConfig(),
    syncTasks: vi.fn().mockResolvedValue(0),
    client: {} as any,
    stateMap: new Map(),
    projectMeta: [],
    inngest: mockInngest,
  });
  return { app, db };
}

// ---------------------------------------------------------------------------
// Bug 1: invocationId = 0 is accepted as valid (Number("0") is not NaN)
// ---------------------------------------------------------------------------

describe("POST /api/hooks/:invocationId — invalid ID edge cases", () => {
  beforeEach(() => {
    invocationLogs.clear();
  });

  it("BUG: returns 400 for invocationId = 0 (autoincrement IDs start at 1)", async () => {
    const { app } = await makeApp();

    const res = await app.request("/api/hooks/0", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "Notification" }),
    });

    // 0 is never a valid invocation ID — autoincrement PKs start at 1.
    // Currently the endpoint accepts 0 because Number("0") is 0 (not NaN).
    expect(res.status).toBe(400);
  });

  it("returns 400 for alphabetic invocationId", async () => {
    const { app } = await makeApp();

    const res = await app.request("/api/hooks/abc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "Notification" }),
    });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Bug 2: field name mismatch — endpoint reads hook_event_name but
// Claude Code sends hook_event_type (and the test itself uses hook_event_type)
// ---------------------------------------------------------------------------

describe("POST /api/hooks/:invocationId — event type field name", () => {
  beforeEach(() => {
    invocationLogs.clear();
  });

  it("BUG: correctly extracts eventType from hook_event_type (Claude Code's actual field)", async () => {
    const { app, db } = await makeApp();

    // Claude Code sends hook_event_type, not hook_event_name.
    // The endpoint reads body["hook_event_name"], so eventType will be "unknown"
    // even when the correct field is present.
    const res = await app.request("/api/hooks/42", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hook_event_type: "Notification",
        message: "hello",
      }),
    });

    expect(res.status).toBe(200);

    // The stored eventType should be "Notification", not "unknown"
    const events = getHookEventsByInvocation(db, 42);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("Notification");
  });

  it("reads hook_event_name when both fields are present", async () => {
    const { app, db } = await makeApp();

    // If the payload contains hook_event_name, it should win.
    const res = await app.request("/api/hooks/43", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "Stop",
        hook_event_type: "Notification",
      }),
    });

    expect(res.status).toBe(200);

    const events = getHookEventsByInvocation(db, 43);
    expect(events).toHaveLength(1);
    // hook_event_name should take precedence if it exists
    expect(events[0].eventType).toBe("Stop");
  });
});

// ---------------------------------------------------------------------------
// Bug 3: command injection in writeHookConfig via hookUrl with single quotes
// ---------------------------------------------------------------------------

describe("writeHookConfig — hookUrl injection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-hook-inject-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("BUG: hookUrl containing single quotes is not safely escaped in curl command", () => {
    // A hookUrl with a single quote breaks out of the shell single-quoted string,
    // enabling command injection.
    const maliciousUrl =
      "http://localhost:4000/api/hooks/1'; touch /tmp/pwned; echo '";
    writeHookConfig(tmpDir, maliciousUrl);

    const settingsPath = join(tmpDir, ".claude", "settings.local.json");
    const config = JSON.parse(readFileSync(settingsPath, "utf8"));
    const command: string = config.hooks.Notification[0].hooks[0].command;

    // The command must either escape the single quotes or use a different quoting strategy.
    // Current implementation does not escape single quotes in the URL.
    // The raw single quote from the URL should NOT appear unescaped in a single-quoted context.
    expect(command).not.toContain("'; touch");
  });

  it("hookUrl with backslashes does not corrupt the JSON or command", () => {
    const urlWithBackslash = "http://localhost:4000/api/hooks/1\\extra";
    writeHookConfig(tmpDir, urlWithBackslash);

    const settingsPath = join(tmpDir, ".claude", "settings.local.json");
    // Should still be valid JSON
    expect(() => JSON.parse(readFileSync(settingsPath, "utf8"))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Bug 4: getOrcaPort() when deploy-state.json has activePort as a string
// ---------------------------------------------------------------------------

describe("getOrcaPort — deploy-state.json edge cases", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-port-test-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    delete process.env["PORT"];
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env["PORT"];
  });

  it("BUG: returns default 4000 when activePort is a string '4001' (type check fails)", () => {
    // Someone wrote activePort as a JSON string instead of a number.
    // The type guard `typeof state.activePort === "number"` will fail,
    // so the port falls through to env var / default even though the file exists.
    const stateFile = join(tmpDir, "deploy-state.json");
    require("node:fs").writeFileSync(
      stateFile,
      JSON.stringify({ activePort: "4001" }),
    );

    const port = getOrcaPort();
    // This should ideally return 4001, but because of the strict type check
    // it returns 4000. The question is whether that's the intended behavior.
    // Since hooks need the right port, this could cause hooks to be silently dropped.
    // This test documents the behavior — if activePort is a string it is ignored.
    expect(port).toBe(4000);
  });

  it("returns activePort when it is a valid number", () => {
    const stateFile = join(tmpDir, "deploy-state.json");
    require("node:fs").writeFileSync(
      stateFile,
      JSON.stringify({ activePort: 4001 }),
    );

    const port = getOrcaPort();
    expect(port).toBe(4001);
  });

  it("falls back to PORT env var when deploy-state.json has no activePort", () => {
    const stateFile = join(tmpDir, "deploy-state.json");
    require("node:fs").writeFileSync(
      stateFile,
      JSON.stringify({ someOtherField: 123 }),
    );
    process.env["PORT"] = "5000";

    const port = getOrcaPort();
    expect(port).toBe(5000);
  });

  it("returns 4000 when deploy-state.json does not exist and PORT is unset", () => {
    const port = getOrcaPort();
    expect(port).toBe(4000);
  });

  it("returns 4000 when deploy-state.json is empty JSON", () => {
    const stateFile = join(tmpDir, "deploy-state.json");
    require("node:fs").writeFileSync(stateFile, "{}");

    const port = getOrcaPort();
    expect(port).toBe(4000);
  });

  it("BUG: returns 4000 when PORT env var is '0' even though 0 > 0 is false (falls to default)", () => {
    // PORT=0 is invalid — should fall to 4000. The current check `parsed > 0` handles this.
    // This is documenting correct behavior, but PORT="" passes Number("") = 0.
    process.env["PORT"] = "0";
    const port = getOrcaPort();
    expect(port).toBe(4000);
  });

  it("returns 4000 when deploy-state.json is malformed JSON", () => {
    const stateFile = join(tmpDir, "deploy-state.json");
    require("node:fs").writeFileSync(stateFile, "not valid json {{");

    const port = getOrcaPort();
    expect(port).toBe(4000);
  });
});

// ---------------------------------------------------------------------------
// Bug 5: hookEvents table has no FK constraint on invocation_id
// — can insert hook events for non-existent invocations without DB error
// ---------------------------------------------------------------------------

describe("insertHookEvent — no FK constraint on invocation_id", () => {
  it("BUG: allows inserting hook events for non-existent invocation IDs", () => {
    const db = createDb(":memory:");

    // invocation_id 999999 does not exist in the invocations table.
    // Because hook_events has no FOREIGN KEY constraint on invocation_id,
    // this insert succeeds silently instead of throwing.
    expect(() => {
      insertHookEvent(
        db,
        999999,
        "Notification",
        JSON.stringify({ test: true }),
      );
    }).not.toThrow();

    // The orphaned row exists with no parent invocation
    const events = getHookEventsByInvocation(db, 999999);
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Bug 6: empty body / null body handling
// ---------------------------------------------------------------------------

describe("POST /api/hooks/:invocationId — body edge cases", () => {
  beforeEach(() => {
    invocationLogs.clear();
  });

  it("returns 400 for empty body (no Content-Type)", async () => {
    const { app } = await makeApp();

    const res = await app.request("/api/hooks/5", {
      method: "POST",
      // No Content-Type header, no body
    });

    // No body at all — should fail with 400, not 500
    expect(res.status).toBe(400);
  });

  it("returns 400 for null JSON body", async () => {
    const { app } = await makeApp();

    const res = await app.request("/api/hooks/5", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });

    // JSON.parse("null") = null which is not Record<string, unknown>.
    // The endpoint casts to Record<string, unknown> without checking.
    // body["hook_event_name"] on null will throw a TypeError.
    expect(res.status).toBe(400);
  });

  it("returns 400 for JSON array body", async () => {
    const { app } = await makeApp();

    const res = await app.request("/api/hooks/5", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "[1, 2, 3]",
    });

    // Arrays are not Record<string, unknown> — should be rejected.
    // The endpoint blindly casts the parsed JSON to Record<string, unknown>.
    expect(res.status).toBe(400);
  });

  it("returns 400 for JSON string body", async () => {
    const { app } = await makeApp();

    const res = await app.request("/api/hooks/5", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '"just a string"',
    });

    // String primitives are not Record<string, unknown> — should be rejected.
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Bug 7: log buffer overflow (buffer cap of 100) does not lose the most
// recent entries — it loses the OLDEST (which may be fine), but let's verify.
// ---------------------------------------------------------------------------

describe("POST /api/hooks/:invocationId — log buffer cap", () => {
  beforeEach(() => {
    invocationLogs.clear();
  });

  it("keeps the 100 most recent entries when buffer overflows", async () => {
    const { app } = await makeApp();

    const logState = {
      buffer: [] as string[],
      emitter: new EventEmitter(),
      done: false,
    };
    invocationLogs.set(10, logState);

    // Send 101 events to trigger the overflow path
    for (let i = 0; i < 101; i++) {
      await app.request("/api/hooks/10", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hook_event_name: "Notification", seq: i }),
      });
    }

    // Buffer should be capped at 100
    expect(logState.buffer.length).toBe(100);

    // The FIRST entry (seq=0) should have been dropped, last entry (seq=100) kept.
    const firstEntry = JSON.parse(logState.buffer[0]);
    expect(firstEntry.data.seq).toBe(1); // seq=0 was shifted out

    const lastEntry = JSON.parse(logState.buffer[99]);
    expect(lastEntry.data.seq).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Bug 8: getHookUrl uses invocationId before the invocation record exists
// — the URL is constructed at session spawn time using the invocationId
// that was just created, so this is fine, but let's verify the URL format.
// ---------------------------------------------------------------------------

describe("getHookUrl", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-hookurl-test-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    delete process.env["PORT"];
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env["PORT"];
  });

  it("produces correct URL format with default port", () => {
    const url = getHookUrl(42);
    expect(url).toBe("http://localhost:4000/api/hooks/42");
  });

  it("produces correct URL with port from deploy-state.json", () => {
    const stateFile = join(tmpDir, "deploy-state.json");
    require("node:fs").writeFileSync(
      stateFile,
      JSON.stringify({ activePort: 4001 }),
    );

    const url = getHookUrl(7);
    expect(url).toBe("http://localhost:4001/api/hooks/7");
  });

});

// ---------------------------------------------------------------------------
// getHookEventsByInvocation — ordering and correctness
// ---------------------------------------------------------------------------

describe("getHookEventsByInvocation", () => {
  it("returns events ordered by id ascending", () => {
    const db = createDb(":memory:");

    insertHookEvent(db, 1, "Notification", JSON.stringify({ seq: 1 }));
    insertHookEvent(db, 1, "Stop", JSON.stringify({ seq: 2 }));
    insertHookEvent(db, 1, "Notification", JSON.stringify({ seq: 3 }));

    const events = getHookEventsByInvocation(db, 1);
    expect(events).toHaveLength(3);
    expect(events[0].eventType).toBe("Notification");
    expect(events[1].eventType).toBe("Stop");
    expect(events[2].eventType).toBe("Notification");
  });

  it("does not return events from a different invocation", () => {
    const db = createDb(":memory:");

    insertHookEvent(db, 1, "Stop", JSON.stringify({ a: 1 }));
    insertHookEvent(db, 2, "Notification", JSON.stringify({ b: 2 }));

    const events = getHookEventsByInvocation(db, 1);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("Stop");
  });

  it("stores and retrieves payload as valid JSON string", () => {
    const db = createDb(":memory:");
    const payload = {
      type: "Notification",
      message: "hello world",
      nested: { x: 1 },
    };

    insertHookEvent(db, 5, "Notification", JSON.stringify(payload));

    const events = getHookEventsByInvocation(db, 5);
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0].payload);
    expect(parsed).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// Migration 21 idempotency — running migration on a DB that already has
// hook_events (e.g. created by CREATE_HOOK_EVENTS on a new DB) should not
// throw even if migration runs again.
// ---------------------------------------------------------------------------

describe("DB migration 21 — hook_events table", () => {
  it("createDb with :memory: creates hook_events table", () => {
    const db = createDb(":memory:");
    // If the table exists, insertHookEvent should succeed
    expect(() => {
      insertHookEvent(db, 1, "Notification", JSON.stringify({ ok: true }));
    }).not.toThrow();
  });

});

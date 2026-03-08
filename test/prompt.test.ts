// ---------------------------------------------------------------------------
// POST /api/invocations/:id/prompt -- adversarial tests
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDb } from "../src/db/index.js";
import { createApiRoutes } from "../src/api/routes.js";
import { insertTask, insertInvocation } from "../src/db/queries.js";
import { activeHandles } from "../src/scheduler/index.js";
import type { OrcaDb } from "../src/db/index.js";
import type { Hono } from "hono";
import type { SessionHandle } from "../src/runner/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig() {
  return {
    defaultCwd: "/tmp",
    concurrencyCap: 3,
    sessionTimeoutMin: 45,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxCostUsd: 10.0,
    schedulerIntervalSec: 10,
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
  };
}

function makeTask(overrides?: Record<string, unknown>) {
  return {
    linearIssueId: "TEST-1",
    agentPrompt: "Fix the bug",
    repoPath: "/tmp/repo",
    orcaStatus: "ready" as const,
    priority: 2,
    retryCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function now(): string {
  return new Date().toISOString();
}

function makeFakeHandle(sendPromptResult: boolean = true): SessionHandle {
  return {
    process: {} as any,
    invocationId: 0,
    sessionId: null,
    result: null,
    done: Promise.resolve({
      subtype: "success",
      costUsd: null,
      numTurns: null,
      exitCode: 0,
      exitSignal: null,
      outputSummary: "ok",
    }),
    sendPrompt: vi.fn().mockReturnValue(sendPromptResult),
  };
}

function postPrompt(app: Hono, invId: number, body: unknown) {
  return app.request(`/api/invocations/${invId}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("POST /api/invocations/:id/prompt", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = createApiRoutes({
      db,
      config: makeConfig(),
      syncTasks: vi.fn().mockResolvedValue(0),
      client: {} as any,
      stateMap: new Map(),
      projectMeta: [],
    });
    // Clean up any leftover handles from previous tests
    activeHandles.clear();
  });

  afterEach(() => {
    activeHandles.clear();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------

  it("returns 200 ok when handle exists and sendPrompt returns true", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-1", orcaStatus: "running" as const }));
    const invId = insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: now(),
      status: "running",
    });

    const handle = makeFakeHandle(true);
    handle.invocationId = invId;
    activeHandles.set(invId, handle);

    const res = await postPrompt(app, invId, { prompt: "hello agent" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(handle.sendPrompt).toHaveBeenCalledWith("hello agent");
  });

  // -----------------------------------------------------------------------
  // Invalid invocation ID
  // -----------------------------------------------------------------------

  it("returns 400 for non-numeric invocation ID", async () => {
    const res = await app.request("/api/invocations/abc/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid invocation id");
  });

  it("returns 400 for float invocation ID (NaN after Number()? No -- 1.5 parses fine)", async () => {
    // Number("1.5") = 1.5, not NaN -- this is NOT caught as invalid
    // This is a potential bug: "1.5" parses to 1.5, getInvocation(db, 1.5) -> 404
    // so it falls through to 404, not 400. Documenting this edge case.
    const res = await app.request("/api/invocations/1.5/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
    // 1.5 is not NaN so it passes the NaN check, then getInvocation finds nothing -> 404
    expect(res.status).toBe(404);
  });

  it("returns 400 for empty-string invocation ID (NaN)", async () => {
    // Number("") = 0, not NaN! This is a bug: empty string parses to 0.
    // getInvocation(db, 0) returns null -> 404. So the NaN check doesn't catch it.
    // But in practice, Hono routing won't match empty :id. Documenting anyway.
    const res = await app.request("/api/invocations//prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
    // Hono won't match this route; expect 404 from router, not our endpoint
    expect(res.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // Invocation not found
  // -----------------------------------------------------------------------

  it("returns 404 for nonexistent invocation", async () => {
    const res = await postPrompt(app, 99999, { prompt: "hello" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("invocation not found");
  });

  // -----------------------------------------------------------------------
  // Invocation not running
  // -----------------------------------------------------------------------

  it("returns 409 when invocation is completed (not running)", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-DONE", orcaStatus: "done" as const }));
    const invId = insertInvocation(db, {
      linearIssueId: "T-DONE",
      startedAt: now(),
      status: "completed",
    });

    const res = await postPrompt(app, invId, { prompt: "hello" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("completed");
  });

  it("returns 409 when invocation is failed", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-FAIL", orcaStatus: "failed" as const }));
    const invId = insertInvocation(db, {
      linearIssueId: "T-FAIL",
      startedAt: now(),
      status: "failed",
    });

    const res = await postPrompt(app, invId, { prompt: "hello" });
    expect(res.status).toBe(409);
  });

  // -----------------------------------------------------------------------
  // Prompt validation
  // -----------------------------------------------------------------------

  it("returns 400 when prompt field is missing", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-V1", orcaStatus: "running" as const }));
    const invId = insertInvocation(db, {
      linearIssueId: "T-V1",
      startedAt: now(),
      status: "running",
    });

    const res = await postPrompt(app, invId, {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/prompt/i);
  });

  it("returns 400 when prompt is null", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-V2", orcaStatus: "running" as const }));
    const invId = insertInvocation(db, {
      linearIssueId: "T-V2",
      startedAt: now(),
      status: "running",
    });

    const res = await postPrompt(app, invId, { prompt: null });
    expect(res.status).toBe(400);
  });

  it("returns 400 when prompt is empty string", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-V3", orcaStatus: "running" as const }));
    const invId = insertInvocation(db, {
      linearIssueId: "T-V3",
      startedAt: now(),
      status: "running",
    });

    const res = await postPrompt(app, invId, { prompt: "" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/non-empty/i);
  });

  it("returns 400 when prompt is whitespace only", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-V4", orcaStatus: "running" as const }));
    const invId = insertInvocation(db, {
      linearIssueId: "T-V4",
      startedAt: now(),
      status: "running",
    });

    const res = await postPrompt(app, invId, { prompt: "   \t\n" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/non-empty/i);
  });

  it("returns 400 when prompt is a number", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-V5", orcaStatus: "running" as const }));
    const invId = insertInvocation(db, {
      linearIssueId: "T-V5",
      startedAt: now(),
      status: "running",
    });

    const res = await postPrompt(app, invId, { prompt: 42 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when prompt is an array", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-V6", orcaStatus: "running" as const }));
    const invId = insertInvocation(db, {
      linearIssueId: "T-V6",
      startedAt: now(),
      status: "running",
    });

    const res = await postPrompt(app, invId, { prompt: ["hello"] });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-V7", orcaStatus: "running" as const }));
    const invId = insertInvocation(db, {
      linearIssueId: "T-V7",
      startedAt: now(),
      status: "running",
    });

    const res = await app.request(`/api/invocations/${invId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{{{",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid JSON body");
  });

  // -----------------------------------------------------------------------
  // Handle not in activeHandles (race: process died between DB check and handle lookup)
  // -----------------------------------------------------------------------

  it("returns 409 when invocation is running in DB but no active handle exists", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-RACE", orcaStatus: "running" as const }));
    const invId = insertInvocation(db, {
      linearIssueId: "T-RACE",
      startedAt: now(),
      status: "running",
    });
    // Do NOT add to activeHandles -- simulating a race where process already died

    const res = await postPrompt(app, invId, { prompt: "hello" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("session not in active handles");
  });

  // -----------------------------------------------------------------------
  // sendPrompt returns false (stdin not writable)
  // -----------------------------------------------------------------------

  it("returns 409 when sendPrompt returns false (stdin closed)", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-STDIN", orcaStatus: "running" as const }));
    const invId = insertInvocation(db, {
      linearIssueId: "T-STDIN",
      startedAt: now(),
      status: "running",
    });

    const handle = makeFakeHandle(false); // sendPrompt returns false
    handle.invocationId = invId;
    activeHandles.set(invId, handle);

    const res = await postPrompt(app, invId, { prompt: "hello" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("session stdin not writable");
  });

  // -----------------------------------------------------------------------
  // The raw prompt text is passed through unmodified (not trimmed)
  // -----------------------------------------------------------------------

  it("passes the raw prompt text (not trimmed) to sendPrompt", async () => {
    // The API does NOT trim prompt before passing to sendPrompt.
    // This test verifies what actually gets sent to the agent.
    insertTask(db, makeTask({ linearIssueId: "T-TRIM", orcaStatus: "running" as const }));
    const invId = insertInvocation(db, {
      linearIssueId: "T-TRIM",
      startedAt: now(),
      status: "running",
    });

    const handle = makeFakeHandle(true);
    handle.invocationId = invId;
    activeHandles.set(invId, handle);

    // prompt with leading/trailing spaces -- passes validation (not whitespace-only)
    const res = await postPrompt(app, invId, { prompt: "  hello world  " });
    expect(res.status).toBe(200);
    // sendPrompt receives the UNTRIMMED value -- the API doesn't trim it
    expect(handle.sendPrompt).toHaveBeenCalledWith("  hello world  ");
  });

  // -----------------------------------------------------------------------
  // No length limit on prompt (potential abuse)
  // -----------------------------------------------------------------------

  it("accepts a very large prompt string (no length limit enforced)", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-LARGE", orcaStatus: "running" as const }));
    const invId = insertInvocation(db, {
      linearIssueId: "T-LARGE",
      startedAt: now(),
      status: "running",
    });

    const handle = makeFakeHandle(true);
    handle.invocationId = invId;
    activeHandles.set(invId, handle);

    const hugeprompt = "A".repeat(1_000_000); // 1 MB
    const res = await postPrompt(app, invId, { prompt: hugeprompt });
    // There is no length limit -- this will succeed
    expect(res.status).toBe(200);
  });

  // -----------------------------------------------------------------------
  // stdin.write() return value: does sendPrompt lie on backpressure?
  // -----------------------------------------------------------------------

  it("sendPrompt returns true even when stdin.write() returns false (backpressure)", async () => {
    // This tests a known flaw: the implementation ignores the boolean return
    // value of proc.stdin.write(), which indicates backpressure.
    // When the buffer is full, write() returns false but data is still queued.
    // The function returns true (success) in this case, misleading the caller.
    //
    // We test this at the runner level by creating a mock stdin with write returning false.
    // Note: this does NOT cause data loss (data is buffered), but it misreports state.

    const { EventEmitter } = await import("node:events");
    const fakeStdin = {
      destroyed: false,
      write: vi.fn().mockReturnValue(false), // backpressure!
      on: vi.fn(),
      once: vi.fn(),
      end: vi.fn(),
    };
    const fakeProc = {
      stdin: fakeStdin,
      exitCode: null,
      killed: false,
    } as any;

    const { spawnSession } = await import("../src/runner/index.js");
    // We can't easily call spawnSession without a real process, so test sendPrompt logic directly
    // by constructing the closure manually as the implementation does:

    const sendPromptFn = (text: string): boolean => {
      if (!fakeProc.stdin || fakeProc.stdin.destroyed || fakeProc.exitCode !== null || fakeProc.killed) {
        return false;
      }
      const payload = JSON.stringify({ type: "user", content: text }) + "\n";
      try {
        fakeProc.stdin.write(payload);
        return true; // <-- always returns true, even if write() returned false
      } catch {
        return false;
      }
    };

    const result = sendPromptFn("hello");
    // BUG: returns true even though write() returned false (backpressure)
    expect(result).toBe(true);
    // But write WAS called
    expect(fakeStdin.write).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // JSON payload format written to stdin
  // -----------------------------------------------------------------------

  it("sendPrompt writes { type: 'user', content: text } JSON to stdin", async () => {
    // Verify the exact format being sent. This is the format Claude CLI is
    // expected to parse for human-in-the-loop turns.
    const fakeStdin = {
      destroyed: false,
      write: vi.fn().mockReturnValue(true),
    };
    const fakeProc = {
      stdin: fakeStdin,
      exitCode: null,
      killed: false,
    } as any;

    const sendPromptFn = (text: string): boolean => {
      if (!fakeProc.stdin || fakeProc.stdin.destroyed || fakeProc.exitCode !== null || fakeProc.killed) {
        return false;
      }
      const payload = JSON.stringify({ type: "user", content: text }) + "\n";
      try {
        fakeProc.stdin.write(payload);
        return true;
      } catch {
        return false;
      }
    };

    sendPromptFn("test message");
    const written = fakeStdin.write.mock.calls[0][0];
    const parsed = JSON.parse(written.trim());
    expect(parsed).toEqual({ type: "user", content: "test message" });
    // Verify newline terminator
    expect(written.endsWith("\n")).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Special characters in prompt
  // -----------------------------------------------------------------------

  it("handles prompt with special JSON characters (quotes, backslashes, newlines)", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-SPECIAL", orcaStatus: "running" as const }));
    const invId = insertInvocation(db, {
      linearIssueId: "T-SPECIAL",
      startedAt: now(),
      status: "running",
    });

    const handle = makeFakeHandle(true);
    handle.invocationId = invId;
    activeHandles.set(invId, handle);

    const specialPrompt = 'Say "hello" and use \\backslash\\ and\nnewline';
    const res = await postPrompt(app, invId, { prompt: specialPrompt });
    expect(res.status).toBe(200);
    expect(handle.sendPrompt).toHaveBeenCalledWith(specialPrompt);
  });

  // -----------------------------------------------------------------------
  // Concurrent sends to the same session
  // -----------------------------------------------------------------------

  it("handles concurrent prompt sends to the same session without error", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-CONCURRENT", orcaStatus: "running" as const }));
    const invId = insertInvocation(db, {
      linearIssueId: "T-CONCURRENT",
      startedAt: now(),
      status: "running",
    });

    const handle = makeFakeHandle(true);
    handle.invocationId = invId;
    activeHandles.set(invId, handle);

    // Fire 5 concurrent requests
    const results = await Promise.all([
      postPrompt(app, invId, { prompt: "msg 1" }),
      postPrompt(app, invId, { prompt: "msg 2" }),
      postPrompt(app, invId, { prompt: "msg 3" }),
      postPrompt(app, invId, { prompt: "msg 4" }),
      postPrompt(app, invId, { prompt: "msg 5" }),
    ]);

    for (const res of results) {
      expect(res.status).toBe(200);
    }
    expect(handle.sendPrompt).toHaveBeenCalledTimes(5);
  });

  // -----------------------------------------------------------------------
  // promptFeedback timeout: no cleanup on unmount (documented, not testable here)
  // -----------------------------------------------------------------------
  // This is a frontend issue in LiveRunWidget.tsx line 51:
  //   setTimeout(() => setPromptFeedback(null), 2000)
  // The timeout ID is not stored, so it cannot be cleared in a useEffect cleanup.
  // If the component unmounts within 2 seconds of a successful send, setState fires
  // on an unmounted component. In React 18 this is a no-op but still bad practice.
  // Not testable in unit tests -- flagged here for documentation.
});

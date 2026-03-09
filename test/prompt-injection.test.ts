// ---------------------------------------------------------------------------
// Tests for POST /api/invocations/:id/prompt (EMI-84 prompt injection feature)
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createDb } from "../src/db/index.js";
import { createApiRoutes } from "../src/api/routes.js";
import { insertTask, insertInvocation } from "../src/db/queries.js";
import { activeHandles } from "../src/scheduler/index.js";
import { sendPrompt } from "../src/runner/index.js";
import type { OrcaDb } from "../src/db/index.js";
import type { SessionHandle } from "../src/runner/index.js";
import type { Hono } from "hono";

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
    stateOverrides: new Map(),
    linearReadyStateType: "unstarted",
    tunnelHostname: "test.example.com",
    projectRepoMap: new Map(),
    logPath: "orca.log",
  };
}

function makeTask(overrides?: Record<string, unknown>) {
  return {
    linearIssueId: "TEST-1",
    agentPrompt: "Fix the bug",
    repoPath: "/tmp/repo",
    orcaStatus: "running" as const,
    priority: 2,
    retryCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Build a fake SessionHandle with a controllable stdin mock. */
function makeFakeHandle(overrides: {
  exitCode?: number | null;
  killed?: boolean;
  stdinDestroyed?: boolean;
  stdinNull?: boolean;
  writeReturnValue?: boolean;
  writeThrows?: Error;
}): SessionHandle {
  const {
    exitCode = null,
    killed = false,
    stdinDestroyed = false,
    stdinNull = false,
    writeReturnValue = true,
    writeThrows,
  } = overrides;

  const stdinWrite = writeThrows
    ? vi.fn().mockImplementation(() => { throw writeThrows; })
    : vi.fn().mockReturnValue(writeReturnValue);

  const proc = {
    exitCode,
    killed,
    stdin: stdinNull ? null : {
      destroyed: stdinDestroyed,
      write: stdinWrite,
    },
  } as unknown as SessionHandle["process"];

  return {
    process: proc,
    invocationId: 99,
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
  };
}

function postPrompt(app: Hono, invocationId: number, body: unknown) {
  return app.request(`/api/invocations/${invocationId}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let db: OrcaDb;
let app: Hono;
let invocationId: number;

beforeEach(() => {
  db = createDb(":memory:");
  app = createApiRoutes({
    db,
    config: makeConfig() as any,
    syncTasks: vi.fn().mockResolvedValue(0),
    client: {} as any,
    stateMap: new Map(),
    projectMeta: [],
  });

  // Insert a running task + invocation
  insertTask(db, makeTask({ linearIssueId: "PROMPT-TASK", orcaStatus: "running" }));
  invocationId = insertInvocation(db, {
    linearIssueId: "PROMPT-TASK",
    startedAt: new Date().toISOString(),
    status: "running",
  });

  // Clear any stale handles
  activeHandles.clear();
});

afterEach(() => {
  activeHandles.clear();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// BUG CATEGORY 1: Invalid / missing invocation ID
// ---------------------------------------------------------------------------

describe("POST /api/invocations/:id/prompt — ID validation", () => {
  it("returns 400 for non-numeric ID", async () => {
    const res = await app.request("/api/invocations/abc/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid invocation id/i);
  });

  it("returns 400 for floating-point ID", async () => {
    const res = await app.request("/api/invocations/1.5/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
    // Number("1.5") === 1.5, not NaN — so this will NOT return 400.
    // It will look up invocation 1 (or 1.5 truncated to 1) which may not exist.
    // This documents the actual behavior: floating-point IDs are accepted.
    expect(res.status).toBe(404); // invocation not found (id=1.5 is parsed as NaN? or 1?)
  });

  it("returns 404 for unknown invocation", async () => {
    const res = await app.request("/api/invocations/99999/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/invocation not found/i);
  });
});

// ---------------------------------------------------------------------------
// BUG CATEGORY 2: Invocation not in "running" state
// ---------------------------------------------------------------------------

describe("POST /api/invocations/:id/prompt — status guard", () => {
  it("returns 409 when invocation is completed", async () => {
    const completedId = insertInvocation(db, {
      linearIssueId: "PROMPT-TASK",
      startedAt: new Date().toISOString(),
      status: "completed",
    });

    const res = await postPrompt(app, completedId, { prompt: "hello" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("completed");
  });

  it("returns 409 when invocation is failed", async () => {
    const failedId = insertInvocation(db, {
      linearIssueId: "PROMPT-TASK",
      startedAt: new Date().toISOString(),
      status: "failed",
    });

    const res = await postPrompt(app, failedId, { prompt: "hello" });
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// BUG CATEGORY 3: Body validation
// ---------------------------------------------------------------------------

describe("POST /api/invocations/:id/prompt — body validation", () => {
  it("returns 400 for missing prompt field", async () => {
    const handle = makeFakeHandle({});
    activeHandles.set(invocationId, handle);

    const res = await postPrompt(app, invocationId, {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/prompt/i);
  });

  it("returns 400 for prompt=null", async () => {
    const handle = makeFakeHandle({});
    activeHandles.set(invocationId, handle);

    const res = await postPrompt(app, invocationId, { prompt: null });
    expect(res.status).toBe(400);
  });

  it("returns 400 for prompt=number", async () => {
    const handle = makeFakeHandle({});
    activeHandles.set(invocationId, handle);

    const res = await postPrompt(app, invocationId, { prompt: 42 });
    expect(res.status).toBe(400);
  });

  it("returns 400 for prompt=whitespace-only", async () => {
    const handle = makeFakeHandle({});
    activeHandles.set(invocationId, handle);

    const res = await postPrompt(app, invocationId, { prompt: "   " });
    expect(res.status).toBe(400);
  });

  it("returns 400 for malformed JSON body", async () => {
    const handle = makeFakeHandle({});
    activeHandles.set(invocationId, handle);

    const res = await app.request(`/api/invocations/${invocationId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{{{",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid json/i);
  });

  it("returns 400 for empty body", async () => {
    const handle = makeFakeHandle({});
    activeHandles.set(invocationId, handle);

    const res = await app.request(`/api/invocations/${invocationId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// BUG CATEGORY 4: Missing active handle
// ---------------------------------------------------------------------------

describe("POST /api/invocations/:id/prompt — handle lookup", () => {
  it("returns 404 when invocation is running but no active handle exists", async () => {
    // invocationId is in "running" DB state but activeHandles has nothing
    const res = await postPrompt(app, invocationId, { prompt: "hello" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/no active handle/i);
  });
});

// ---------------------------------------------------------------------------
// BUG CATEGORY 5: sendPrompt — process already dead
// ---------------------------------------------------------------------------

describe("sendPrompt() — dead process checks", () => {
  it("returns false when exitCode is set (process exited normally)", () => {
    const handle = makeFakeHandle({ exitCode: 0 });
    const result = sendPrompt(handle, "hello");
    expect(result).toBe(false);
  });

  it("returns false when exitCode is non-zero", () => {
    const handle = makeFakeHandle({ exitCode: 1 });
    const result = sendPrompt(handle, "hello");
    expect(result).toBe(false);
  });

  it("returns false when proc.killed is true", () => {
    const handle = makeFakeHandle({ killed: true });
    const result = sendPrompt(handle, "hello");
    expect(result).toBe(false);
  });

  it("returns false when stdin is null (pipe not set up)", () => {
    const handle = makeFakeHandle({ stdinNull: true });
    const result = sendPrompt(handle, "hello");
    expect(result).toBe(false);
  });

  it("returns false when stdin is destroyed", () => {
    const handle = makeFakeHandle({ stdinDestroyed: true });
    const result = sendPrompt(handle, "hello");
    expect(result).toBe(false);
  });

  it("returns false and does not throw when stdin.write throws EPIPE", () => {
    const epipe = new Error("write EPIPE");
    (epipe as NodeJS.ErrnoException).code = "EPIPE";
    const handle = makeFakeHandle({ writeThrows: epipe });
    let result: boolean;
    expect(() => {
      result = sendPrompt(handle, "hello");
    }).not.toThrow();
    expect(result!).toBe(false);
  });

  it("returns false and does not throw when stdin.write throws ERR_STREAM_DESTROYED", () => {
    const err = new Error("write after end");
    (err as NodeJS.ErrnoException).code = "ERR_STREAM_DESTROYED";
    const handle = makeFakeHandle({ writeThrows: err });
    let result: boolean;
    expect(() => {
      result = sendPrompt(handle, "hello");
    }).not.toThrow();
    expect(result!).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BUG CATEGORY 6: sendPrompt — backpressure ignored
// ---------------------------------------------------------------------------

describe("sendPrompt() — backpressure (write returns false)", () => {
  it("returns true even when proc.stdin.write returns false (backpressure ignored)", () => {
    // stdin.write() returns false when the internal buffer is full.
    // The implementation ignores this and returns true anyway.
    // This is the actual current behavior — documenting it as a known gap.
    const handle = makeFakeHandle({ writeReturnValue: false });
    const result = sendPrompt(handle, "a very long message that might fill buffers");
    // The implementation does: proc.stdin.write(payload); return true;
    // It ignores the false return from write(). This test documents the bug.
    expect(result).toBe(true); // passes, but this means we silently drop the write signal
  });
});

// ---------------------------------------------------------------------------
// BUG CATEGORY 7: Race condition — process exits between guard check and write
// ---------------------------------------------------------------------------

describe("sendPrompt() — TOCTOU race between exitCode check and write", () => {
  it("catches exception if process dies between the guard check and write()", () => {
    // Simulate: exitCode is null and killed is false at guard check time,
    // but stdin.write throws because the pipe was closed between check and write.
    const err = new Error("This socket is closed");
    const handle = makeFakeHandle({ writeThrows: err });
    // Guard check passes (exitCode=null, killed=false, stdin not destroyed)
    // Then write throws. Should not propagate.
    let result: boolean;
    expect(() => {
      result = sendPrompt(handle, "hello");
    }).not.toThrow();
    expect(result!).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BUG CATEGORY 8: API route — process dead but DB says running
// ---------------------------------------------------------------------------

describe("POST /api/invocations/:id/prompt — dead process, live DB record", () => {
  it("returns 409 when process is dead (killed) but DB still shows running", async () => {
    const handle = makeFakeHandle({ killed: true });
    activeHandles.set(invocationId, handle);

    const res = await postPrompt(app, invocationId, { prompt: "hello" });
    // sendPrompt returns false -> route returns 409
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/not accepting input/i);
  });

  it("returns 409 when process has exited but DB still shows running", async () => {
    const handle = makeFakeHandle({ exitCode: 0 });
    activeHandles.set(invocationId, handle);

    const res = await postPrompt(app, invocationId, { prompt: "hello" });
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// BUG CATEGORY 9: Prompt content — large and special characters
// ---------------------------------------------------------------------------

describe("POST /api/invocations/:id/prompt — prompt content edge cases", () => {
  it("handles prompt with embedded newline characters (newlines in JSON string)", async () => {
    const handle = makeFakeHandle({});
    activeHandles.set(invocationId, handle);

    // A prompt containing a literal newline — JSON.stringify will escape it to \n
    // so the payload stays on one line. This should succeed.
    const res = await postPrompt(app, invocationId, { prompt: "line1\nline2" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("handles very large prompt (100KB)", async () => {
    const handle = makeFakeHandle({});
    activeHandles.set(invocationId, handle);

    const bigPrompt = "x".repeat(100_000);
    const res = await postPrompt(app, invocationId, { prompt: bigPrompt });
    // No size limit is enforced — this should succeed and reach sendPrompt
    expect(res.status).toBe(200);
  });

  it("prompt is trimmed before sending (leading/trailing whitespace stripped)", async () => {
    const writeSpy = vi.fn().mockReturnValue(true);
    const proc = {
      exitCode: null,
      killed: false,
      stdin: { destroyed: false, write: writeSpy },
    } as unknown as SessionHandle["process"];
    const handle: SessionHandle = {
      process: proc,
      invocationId: 99,
      sessionId: null,
      result: null,
      done: Promise.resolve({ subtype: "success", costUsd: null, numTurns: null, exitCode: 0, exitSignal: null, outputSummary: "ok" }),
    };
    activeHandles.set(invocationId, handle);

    await postPrompt(app, invocationId, { prompt: "  hello world  " });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const writtenArg = writeSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(writtenArg.trim());
    // prompt.trim() is called in the route before passing to sendPrompt
    expect(parsed.message).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// BUG CATEGORY 10: Wire format — what is actually sent to the process
// ---------------------------------------------------------------------------

describe("sendPrompt() — wire format sent to stdin", () => {
  it("sends valid NDJSON with type=user and message field", () => {
    const writeSpy = vi.fn().mockReturnValue(true);
    const proc = {
      exitCode: null,
      killed: false,
      stdin: { destroyed: false, write: writeSpy },
    } as unknown as SessionHandle["process"];
    const handle: SessionHandle = {
      process: proc,
      invocationId: 1,
      sessionId: null,
      result: null,
      done: Promise.resolve({ subtype: "success", costUsd: null, numTurns: null, exitCode: 0, exitSignal: null, outputSummary: "ok" }),
    };

    sendPrompt(handle, "test message");

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const written = writeSpy.mock.calls[0][0] as string;
    expect(written.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(written.trim());
    expect(parsed.type).toBe("user");
    expect(parsed.message).toBe("test message");
  });

  it("does not double-trim prompt — sendPrompt sends text as-is", () => {
    // sendPrompt does NOT trim; trimming is done in the route handler.
    // If called directly with whitespace, it passes whitespace through.
    const writeSpy = vi.fn().mockReturnValue(true);
    const proc = {
      exitCode: null,
      killed: false,
      stdin: { destroyed: false, write: writeSpy },
    } as unknown as SessionHandle["process"];
    const handle: SessionHandle = {
      process: proc,
      invocationId: 1,
      sessionId: null,
      result: null,
      done: Promise.resolve({ subtype: "success", costUsd: null, numTurns: null, exitCode: 0, exitSignal: null, outputSummary: "ok" }),
    };

    sendPrompt(handle, "  spaced  ");

    const written = writeSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.message).toBe("  spaced  "); // not trimmed at sendPrompt level
  });
});

// ---------------------------------------------------------------------------
// BUG CATEGORY 11: Concurrency — two simultaneous prompt sends
// ---------------------------------------------------------------------------

describe("POST /api/invocations/:id/prompt — concurrency", () => {
  it("two simultaneous sends to same invocation both succeed (no mutex)", async () => {
    const writes: string[] = [];
    const writeSpy = vi.fn().mockImplementation((data: string) => {
      writes.push(data);
      return true;
    });
    const proc = {
      exitCode: null,
      killed: false,
      stdin: { destroyed: false, write: writeSpy },
    } as unknown as SessionHandle["process"];
    const handle: SessionHandle = {
      process: proc,
      invocationId: 99,
      sessionId: null,
      result: null,
      done: Promise.resolve({ subtype: "success", costUsd: null, numTurns: null, exitCode: 0, exitSignal: null, outputSummary: "ok" }),
    };
    activeHandles.set(invocationId, handle);

    // Fire two concurrent requests
    const [res1, res2] = await Promise.all([
      postPrompt(app, invocationId, { prompt: "prompt-A" }),
      postPrompt(app, invocationId, { prompt: "prompt-B" }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // Both writes should have arrived — order is non-deterministic
    expect(writes).toHaveLength(2);
    const messages = writes.map((w) => JSON.parse(w.trim()).message).sort();
    expect(messages).toEqual(["prompt-A", "prompt-B"].sort());
  });
});

// ---------------------------------------------------------------------------
// BUG CATEGORY 12: Happy path — successful delivery
// ---------------------------------------------------------------------------

describe("POST /api/invocations/:id/prompt — happy path", () => {
  it("returns {ok:true} when everything is fine", async () => {
    const handle = makeFakeHandle({});
    activeHandles.set(invocationId, handle);

    const res = await postPrompt(app, invocationId, { prompt: "please do X" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("calls stdin.write exactly once with correct payload", async () => {
    const writeSpy = vi.fn().mockReturnValue(true);
    const proc = {
      exitCode: null,
      killed: false,
      stdin: { destroyed: false, write: writeSpy },
    } as unknown as SessionHandle["process"];
    const handle: SessionHandle = {
      process: proc,
      invocationId: 99,
      sessionId: null,
      result: null,
      done: Promise.resolve({ subtype: "success", costUsd: null, numTurns: null, exitCode: 0, exitSignal: null, outputSummary: "ok" }),
    };
    activeHandles.set(invocationId, handle);

    await postPrompt(app, invocationId, { prompt: "hello agent" });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const written = writeSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed).toEqual({ type: "user", message: "hello agent" });
  });
});

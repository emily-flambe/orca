// ---------------------------------------------------------------------------
// Tests for src/inngest/activities/session-bridge.ts
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Must be `var` (not `let`) so it's hoisted and accessible when vi.mock runs
// eslint-disable-next-line no-var
var mockInngestSend: ReturnType<typeof vi.fn>;

vi.mock("../src/inngest/client.js", () => ({
  inngest: {
    send: (...args: unknown[]) => mockInngestSend(...args),
  },
}));

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { monitorSession } from "../src/inngest/activities/session-bridge.js";
import type { SessionResult } from "../src/runner/index.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockInngestSend = vi.fn().mockResolvedValue(undefined);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionResult(
  overrides: Partial<SessionResult> = {},
): SessionResult {
  return {
    subtype: "success",
    costUsd: 0.01,
    inputTokens: 100,
    outputTokens: 50,
    numTurns: 5,
    exitCode: 0,
    exitSignal: null,
    outputSummary: "Task completed",
    isResumeNotFound: false,
    ...overrides,
  };
}

function makeHandle(result: SessionResult | Promise<SessionResult>) {
  const done =
    result instanceof Promise ? result : Promise.resolve(result);
  return {
    done,
    sessionId: "session-abc-123",
    kill: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("monitorSession", () => {
  test("success subtype → sends session/completed with correct fields", async () => {
    const result = makeSessionResult({ subtype: "success", exitCode: 0 });
    const handle = makeHandle(result);

    monitorSession(handle, "TASK-1", "implement", 42, {
      branchName: "orca/TASK-1-inv-1",
      worktreePath: "/repo/worktree",
    });

    await vi.runAllTimersAsync();
    await Promise.resolve(); // flush microtasks

    expect(mockInngestSend).toHaveBeenCalledTimes(1);
    expect(mockInngestSend).toHaveBeenCalledWith({
      name: "session/completed",
      data: expect.objectContaining({
        invocationId: 42,
        linearIssueId: "TASK-1",
        phase: "implement",
        exitCode: 0,
        isMaxTurns: false,
        sessionId: "session-abc-123",
        branchName: "orca/TASK-1-inv-1",
        worktreePath: "/repo/worktree",
      }),
    });
  });

  test("error_max_turns subtype → sends session/completed with isMaxTurns: true", async () => {
    const result = makeSessionResult({
      subtype: "error_max_turns",
      exitCode: 1,
    });
    const handle = makeHandle(result);

    monitorSession(handle, "TASK-1", "implement", 42);

    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mockInngestSend).toHaveBeenCalledWith({
      name: "session/completed",
      data: expect.objectContaining({
        isMaxTurns: true,
        exitCode: 1,
      }),
    });
  });

  test("error_during_execution (non-content-filtered) → sends session/failed", async () => {
    const result = makeSessionResult({
      subtype: "error_during_execution",
      exitCode: 1,
      outputSummary: "Something went wrong",
    });
    const handle = makeHandle(result);

    monitorSession(handle, "TASK-1", "implement", 42);

    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mockInngestSend).toHaveBeenCalledWith({
      name: "session/failed",
      data: expect.objectContaining({
        invocationId: 42,
        isRateLimited: false,
        isContentFiltered: false,
      }),
    });
  });

  test("rate_limited subtype → sends session/failed with isRateLimited: true", async () => {
    const result = makeSessionResult({
      subtype: "rate_limited",
      exitCode: 1,
    });
    const handle = makeHandle(result);

    monitorSession(handle, "TASK-2", "review", 99);

    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mockInngestSend).toHaveBeenCalledWith({
      name: "session/failed",
      data: expect.objectContaining({
        isRateLimited: true,
        isContentFiltered: false,
      }),
    });
  });

  test("error_during_execution + content filtering message → sends session/failed with isContentFiltered: true", async () => {
    const result = makeSessionResult({
      subtype: "error_during_execution",
      exitCode: 1,
      outputSummary: "Output blocked by content filtering policy",
    });
    const handle = makeHandle(result);

    monitorSession(handle, "TASK-3", "implement", 77);

    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mockInngestSend).toHaveBeenCalledWith({
      name: "session/failed",
      data: expect.objectContaining({
        isContentFiltered: true,
        isRateLimited: false,
      }),
    });
  });

  test("passes meta.branchName and meta.worktreePath into session/completed event", async () => {
    const result = makeSessionResult({ subtype: "success" });
    const handle = makeHandle(result);

    monitorSession(handle, "TASK-1", "implement", 42, {
      branchName: "orca/TASK-1-inv-3",
      worktreePath: "/some/path",
    });

    await vi.runAllTimersAsync();
    await Promise.resolve();

    const call = mockInngestSend.mock.calls[0]![0] as {
      data: { branchName: string; worktreePath: string };
    };
    expect(call.data.branchName).toBe("orca/TASK-1-inv-3");
    expect(call.data.worktreePath).toBe("/some/path");
  });

  test("meta defaults to null when not provided", async () => {
    const result = makeSessionResult({ subtype: "success" });
    const handle = makeHandle(result);

    monitorSession(handle, "TASK-1", "implement", 42);

    await vi.runAllTimersAsync();
    await Promise.resolve();

    const call = mockInngestSend.mock.calls[0]![0] as {
      data: { branchName: null; worktreePath: null };
    };
    expect(call.data.branchName).toBeNull();
    expect(call.data.worktreePath).toBeNull();
  });

  test("uses exitCode ?? 0 for session/completed when exitCode is null", async () => {
    const result = makeSessionResult({ subtype: "success", exitCode: null });
    const handle = makeHandle(result);

    monitorSession(handle, "TASK-1", "implement", 42);

    await vi.runAllTimersAsync();
    await Promise.resolve();

    const call = mockInngestSend.mock.calls[0]![0] as {
      data: { exitCode: number };
    };
    expect(call.data.exitCode).toBe(0);
  });

  test("uses exitCode ?? 1 for session/failed when exitCode is null", async () => {
    const result = makeSessionResult({
      subtype: "error_during_execution",
      exitCode: null,
    });
    const handle = makeHandle(result);

    monitorSession(handle, "TASK-1", "implement", 42);

    await vi.runAllTimersAsync();
    await Promise.resolve();

    const call = mockInngestSend.mock.calls[0]![0] as {
      data: { exitCode: number };
    };
    expect(call.data.exitCode).toBe(1);
  });

  test("inngest.send fails twice then succeeds on 3rd attempt → event is sent", async () => {
    let attempt = 0;
    mockInngestSend.mockImplementation(() => {
      attempt++;
      if (attempt < 3) return Promise.reject(new Error("transient"));
      return Promise.resolve(undefined);
    });

    const result = makeSessionResult({ subtype: "success" });
    const handle = makeHandle(result);

    monitorSession(handle, "TASK-1", "implement", 42);

    // Flush the initial promise resolution
    await Promise.resolve();

    // Advance through the retry delays (1s after attempt 1, 2s after attempt 2)
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.resolve();

    expect(mockInngestSend).toHaveBeenCalledTimes(3);
  });

  test("inngest.send fails all 3 attempts → logs error, does not throw", async () => {
    mockInngestSend.mockRejectedValue(new Error("persistent failure"));

    const result = makeSessionResult({ subtype: "success" });
    const handle = makeHandle(result);

    // Should not throw (fire-and-forget)
    expect(() =>
      monitorSession(handle, "TASK-1", "implement", 42),
    ).not.toThrow();

    // Flush all async work
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.resolve();
    await Promise.resolve();

    // inngest.send was called 3 times (all failed)
    expect(mockInngestSend).toHaveBeenCalledTimes(3);
  });

  test("session/failed event includes sessionId from handle", async () => {
    const result = makeSessionResult({ subtype: "rate_limited" });
    const handle = makeHandle(result);

    monitorSession(handle, "TASK-5", "review", 10);

    await vi.runAllTimersAsync();
    await Promise.resolve();

    const call = mockInngestSend.mock.calls[0]![0] as {
      data: { sessionId: string };
    };
    expect(call.data.sessionId).toBe("session-abc-123");
  });

  test("session/completed includes costUsd, inputTokens, outputTokens from result", async () => {
    const result = makeSessionResult({
      subtype: "success",
      costUsd: 0.05,
      inputTokens: 1000,
      outputTokens: 500,
    });
    const handle = makeHandle(result);

    monitorSession(handle, "TASK-1", "implement", 42);

    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mockInngestSend).toHaveBeenCalledWith({
      name: "session/completed",
      data: expect.objectContaining({
        costUsd: 0.05,
        inputTokens: 1000,
        outputTokens: 500,
      }),
    });
  });
});

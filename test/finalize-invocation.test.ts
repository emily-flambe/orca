// ---------------------------------------------------------------------------
// Tests for src/inngest/workflows/finalize-invocation.ts
//
// Verifies the consolidated finalization utility handles edge cases:
// - double finalization (idempotency)
// - missing invocation (no-op DB update)
// - activeHandles cleanup
// - null vs undefined data fields
// - all status values
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../src/db/queries.js", () => ({
  getInvocation: vi.fn(),
  updateInvocation: vi.fn(),
}));

vi.mock("../src/session-handles.js", () => ({
  activeHandles: new Map(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { getInvocation, updateInvocation } from "../src/db/queries.js";
import { activeHandles } from "../src/session-handles.js";
import {
  finalizeInvocation,
  type SessionResultData,
} from "../src/inngest/workflows/finalize-invocation.js";

const mockGetInvocation = vi.mocked(getInvocation);
const mockUpdateInvocation = vi.mocked(updateInvocation);
const mockDb = {} as never;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("finalizeInvocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeHandles.clear();
    // Default: invocation exists in non-terminal status so the idempotency guard passes
    mockGetInvocation.mockReturnValue({ status: "running" });
  });

  test("sets status and endedAt with no data", () => {
    finalizeInvocation(mockDb, 1, "completed");

    expect(mockUpdateInvocation).toHaveBeenCalledOnce();
    const [db, id, updates] = mockUpdateInvocation.mock.calls[0];
    expect(db).toBe(mockDb);
    expect(id).toBe(1);
    expect(updates.status).toBe("completed");
    expect(updates.endedAt).toBeDefined();
    expect(typeof updates.endedAt).toBe("string");
    // Should be a valid ISO date
    expect(new Date(updates.endedAt!).toISOString()).toBe(updates.endedAt);
  });

  test("sets status to 'failed'", () => {
    finalizeInvocation(mockDb, 2, "failed");

    const [, , updates] = mockUpdateInvocation.mock.calls[0];
    expect(updates.status).toBe("failed");
  });

  test("sets status to 'timed_out'", () => {
    finalizeInvocation(mockDb, 3, "timed_out");

    const [, , updates] = mockUpdateInvocation.mock.calls[0];
    expect(updates.status).toBe("timed_out");
  });

  test("includes cost and token data when provided", () => {
    const data: SessionResultData = {
      costUsd: 0.05,
      inputTokens: 1000,
      outputTokens: 2000,
      numTurns: 10,
      outputSummary: "Task completed successfully",
    };

    finalizeInvocation(mockDb, 1, "completed", data);

    const [, , updates] = mockUpdateInvocation.mock.calls[0];
    expect(updates.costUsd).toBe(0.05);
    expect(updates.inputTokens).toBe(1000);
    expect(updates.outputTokens).toBe(2000);
    expect(updates.numTurns).toBe(10);
    expect(updates.outputSummary).toBe("Task completed successfully");
  });

  test("includes null values when data fields are null", () => {
    // This is the pattern used throughout the codebase:
    // costUsd: sessionEvent.data.costUsd ?? null
    const data: SessionResultData = {
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
    };

    finalizeInvocation(mockDb, 1, "completed", data);

    const [, , updates] = mockUpdateInvocation.mock.calls[0];
    // null !== undefined, so the fields should be included
    expect(updates.costUsd).toBeNull();
    expect(updates.inputTokens).toBeNull();
    expect(updates.outputTokens).toBeNull();
  });

  test("omits fields that are undefined in data", () => {
    // When data is provided but fields are undefined, they should NOT be
    // included in the update (the `!== undefined` guard should skip them)
    const data: SessionResultData = {
      costUsd: 0.01,
      // inputTokens, outputTokens, numTurns, outputSummary are all undefined
    };

    finalizeInvocation(mockDb, 1, "completed", data);

    const [, , updates] = mockUpdateInvocation.mock.calls[0];
    expect(updates.costUsd).toBe(0.01);
    expect(updates).not.toHaveProperty("inputTokens");
    expect(updates).not.toHaveProperty("outputTokens");
    expect(updates).not.toHaveProperty("numTurns");
    expect(updates).not.toHaveProperty("outputSummary");
  });

  test("deletes invocation from activeHandles", () => {
    const mockHandle = { done: Promise.resolve(), kill: vi.fn() };
    activeHandles.set(42, mockHandle as never);

    expect(activeHandles.has(42)).toBe(true);

    finalizeInvocation(mockDb, 42, "completed");

    expect(activeHandles.has(42)).toBe(false);
  });

  test("does not throw when invocation is not in activeHandles", () => {
    // Map.delete on a missing key is a no-op, should not throw
    expect(activeHandles.has(999)).toBe(false);

    expect(() => {
      finalizeInvocation(mockDb, 999, "failed");
    }).not.toThrow();
  });

  test("double finalization is idempotent — second call is a no-op", () => {
    // finalizeInvocation checks current status first. If already terminal,
    // it skips the update but still cleans up activeHandles.
    activeHandles.set(1, { done: Promise.resolve(), kill: vi.fn() } as never);

    // First call: getInvocation returns running (non-terminal) → update proceeds
    mockGetInvocation.mockReturnValueOnce({ status: "running" });
    finalizeInvocation(mockDb, 1, "completed", { costUsd: 0.05 });

    // Second call: getInvocation returns completed (terminal) → update skipped
    mockGetInvocation.mockReturnValueOnce({ status: "completed" });
    finalizeInvocation(mockDb, 1, "failed");

    // Only the first call should have updated the DB
    expect(mockUpdateInvocation).toHaveBeenCalledTimes(1);
    const [, , updates] = mockUpdateInvocation.mock.calls[0];
    expect(updates.status).toBe("completed");

    // activeHandles should still be cleaned up (try/finally)
    expect(activeHandles.has(1)).toBe(false);
  });

  test("handles data with all fields set to zero", () => {
    // Zero is a valid value (not undefined, not null) — should be included
    const data: SessionResultData = {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      numTurns: 0,
    };

    finalizeInvocation(mockDb, 1, "completed", data);

    const [, , updates] = mockUpdateInvocation.mock.calls[0];
    expect(updates.costUsd).toBe(0);
    expect(updates.inputTokens).toBe(0);
    expect(updates.outputTokens).toBe(0);
    expect(updates.numTurns).toBe(0);
  });

  test("handles empty data object", () => {
    // All fields undefined in an empty object — should only have status + endedAt
    finalizeInvocation(mockDb, 1, "completed", {});

    const [, , updates] = mockUpdateInvocation.mock.calls[0];
    expect(Object.keys(updates)).toEqual(
      expect.arrayContaining(["status", "endedAt"]),
    );
    // Should NOT have any of the optional fields
    expect(updates).not.toHaveProperty("costUsd");
    expect(updates).not.toHaveProperty("inputTokens");
    expect(updates).not.toHaveProperty("outputTokens");
    expect(updates).not.toHaveProperty("numTurns");
    expect(updates).not.toHaveProperty("outputSummary");
  });

  test("propagates DB errors from updateInvocation", () => {
    // If the DB throws (e.g., invocation ID doesn't exist), the error
    // should propagate up — finalizeInvocation re-throws after finally
    mockUpdateInvocation.mockImplementationOnce(() => {
      throw new Error("SQLITE_ERROR: no such row");
    });

    expect(() => {
      finalizeInvocation(mockDb, 999, "failed");
    }).toThrow("SQLITE_ERROR: no such row");

    // With try/finally, activeHandles.delete IS called even on error
  });

  test("handle cleanup on DB error: activeHandles entry is deleted even if updateInvocation throws", () => {
    const mockHandle = { done: Promise.resolve(), kill: vi.fn() };
    activeHandles.set(77, mockHandle as never);

    mockUpdateInvocation.mockImplementationOnce(() => {
      throw new Error("DB write failed");
    });

    expect(() => finalizeInvocation(mockDb, 77, "failed")).toThrow(
      "DB write failed",
    );

    // With try/finally, activeHandles.delete runs even when updateInvocation throws
    expect(activeHandles.has(77)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bridge + workflow double-finalization race
// ---------------------------------------------------------------------------

describe("bridge DB fallback + workflow finalize race", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeHandles.clear();
    mockGetInvocation.mockReturnValue({ status: "running" });
  });

  test("bridge fallback followed by workflow timeout — second call blocked by idempotency guard", () => {
    // Scenario: bridge DB fallback sets "completed", then workflow timeout
    // tries to set "timed_out". The idempotency guard blocks the second write.
    mockGetInvocation.mockReturnValueOnce({ status: "running" }); // first call: non-terminal
    finalizeInvocation(mockDb, 1, "completed", { costUsd: 0.05 });

    mockGetInvocation.mockReturnValueOnce({ status: "completed" }); // second call: already terminal
    finalizeInvocation(mockDb, 1, "timed_out", {
      outputSummary: "session timed out after 45 minutes",
    });

    // Only the first write goes through — idempotency guard blocks second
    expect(mockUpdateInvocation).toHaveBeenCalledTimes(1);

    // The first (correct) status and cost data is preserved
    const firstUpdate = mockUpdateInvocation.mock.calls[0][2];
    expect(firstUpdate.status).toBe("completed");
    expect(firstUpdate.costUsd).toBe(0.05);
  });

  test("bridge fallback sets 'failed' then workflow also sets 'timed_out' — second call blocked", () => {
    // This is the realistic scenario: session fails, bridge can't send event,
    // falls back to DB with "failed". Workflow times out and tries "timed_out".
    // Idempotency guard blocks the second write.
    mockGetInvocation.mockReturnValueOnce({ status: "running" }); // first call
    finalizeInvocation(mockDb, 1, "failed", {
      costUsd: 0.03,
      inputTokens: 500,
      outputTokens: 800,
    });

    mockGetInvocation.mockReturnValueOnce({ status: "failed" }); // second call: already terminal
    finalizeInvocation(mockDb, 1, "timed_out", {
      outputSummary: "session timed out",
    });

    // Only first write goes through
    expect(mockUpdateInvocation).toHaveBeenCalledTimes(1);

    // Token data from the first (correct) finalization is preserved
    const firstUpdate = mockUpdateInvocation.mock.calls[0][2];
    expect(firstUpdate.costUsd).toBe(0.03);
    expect(firstUpdate.inputTokens).toBe(500);
    expect(firstUpdate.outputTokens).toBe(800);
  });
});

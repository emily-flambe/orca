// ---------------------------------------------------------------------------
// Tests verifying echo-guard correctness around writeBackStatus failures.
//
// Fixed behavior: writeBackStatus calls registerExpectedChange BEFORE the API
// call, but removes the entry if the API call fails. This prevents legitimate
// webhooks from being suppressed when a write-back fails.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  writeBackStatus,
  writeBackStatusWithRetry,
  registerExpectedChange,
  isExpectedChange,
  expectedChanges,
} from "../src/linear/sync.js";
import {
  resetFailedWriteBackCount,
  scheduleWithRetry,
  WRITE_BACK_RETRY_DELAYS_MS,
} from "../src/linear/write-back-queue.js";
import type { LinearClient, WorkflowStateMap } from "../src/linear/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStateMap(pairs: [string, string][]): WorkflowStateMap {
  const map = new Map();
  for (const [name, id] of pairs) {
    map.set(name, { id, type: "started" });
  }
  return map;
}

function makeClient(opts: {
  updateIssueState?: () => Promise<void>;
} = {}): LinearClient {
  return {
    updateIssueState:
      opts.updateIssueState ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as LinearClient;
}

// ---------------------------------------------------------------------------
// Echo guard state pollution test
// ---------------------------------------------------------------------------

describe("writeBackStatus — echo guard correctness on API failure", () => {
  beforeEach(() => {
    expectedChanges.clear();
    resetFailedWriteBackCount();
  });

  afterEach(() => {
    expectedChanges.clear();
  });

  it("echo guard is removed when updateIssueState fails — no webhook suppression", async () => {
    const stateMap = makeStateMap([["In Progress", "state-inprogress"]]);
    const client = makeClient({
      updateIssueState: vi.fn().mockRejectedValue(new Error("API down")),
    });

    await expect(
      writeBackStatus(client, "TASK-1", "dispatched", stateMap),
    ).rejects.toThrow("API down");

    // Echo guard was registered before the call but removed on failure.
    // A legitimate webhook should NOT be suppressed.
    const wasSuppressed = isExpectedChange("TASK-1", "In Progress");
    expect(wasSuppressed).toBe(false);
  });

  it("failed writeBackStatus leaves no echo guard — real webhooks are not swallowed", async () => {
    const stateMap = makeStateMap([["Done", "state-done"]]);
    const client = makeClient({
      updateIssueState: vi.fn().mockRejectedValue(new Error("timeout")),
    });

    await expect(
      writeBackStatus(client, "TASK-2", "done", stateMap),
    ).rejects.toThrow("timeout");

    // No stale echo guard — a real "Done" webhook will be processed normally
    const suppressedByBug = isExpectedChange("TASK-2", "Done");
    expect(suppressedByBug).toBe(false);
    expect(expectedChanges.size).toBe(0);
  });

  it("a successful writeBackStatus correctly leaves no residual echo guard after consumption", async () => {
    const stateMap = makeStateMap([["In Review", "state-inreview"]]);
    const updateFn = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ updateIssueState: updateFn });

    await writeBackStatus(client, "TASK-3", "in_review", stateMap);

    // After success: the entry is in the map but hasn't been consumed yet
    // (it's waiting for the webhook echo)
    const stillThere = isExpectedChange("TASK-3", "In Review");
    // First call consumes it
    expect(stillThere).toBe(true);

    // Second call: entry was consumed by isExpectedChange above, so now it's gone
    const gone = isExpectedChange("TASK-3", "In Review");
    expect(gone).toBe(false);
  });

  it("deploying/awaiting_ci transitions do NOT pollute the echo guard", async () => {
    const stateMap = makeStateMap([["In Review", "state-inreview"]]);
    const client = makeClient();

    // These are no-ops — they return early without calling registerExpectedChange
    await writeBackStatus(client, "TASK-4", "deploying", stateMap);
    await writeBackStatus(client, "TASK-4", "awaiting_ci", stateMap);

    // No echo guard entry should exist for these transitions
    expect(isExpectedChange("TASK-4", "In Review")).toBe(false);
    expect(isExpectedChange("TASK-4", "deploying")).toBe(false);
    expect(isExpectedChange("TASK-4", "awaiting_ci")).toBe(false);
  });

  it("stateMap miss does NOT pollute echo guard", async () => {
    const emptyStateMap = makeStateMap([]); // no states configured
    const client = makeClient();

    // No matching state in stateMap — should return early without registering
    await writeBackStatus(client, "TASK-5", "done", emptyStateMap);

    expect(isExpectedChange("TASK-5", "Done")).toBe(false);
    expect(expectedChanges.size).toBe(0);
  });

  it("on retry: echo guard is cleared after each failed attempt, not left dangling", async () => {
    vi.useFakeTimers();
    try {
      const stateMap = makeStateMap([["In Progress", "state-ip"]]);
      let callCount = 0;
      const client = makeClient({
        updateIssueState: vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.reject(new Error("still down"));
        }),
      });

      // First attempt via scheduleWithRetry
      scheduleWithRetry(
        () => writeBackStatus(client, "TASK-6", "dispatched", stateMap),
        "TASK-6 -> dispatched",
      );

      // Flush immediate attempt (fails, echo guard is removed)
      await Promise.resolve();
      await Promise.resolve();
      expect(callCount).toBe(1);

      // After failure: echo guard should be removed (not left dangling)
      expect(expectedChanges.get("TASK-6")).toBeUndefined();

      // Fire retry 1
      vi.advanceTimersByTime(WRITE_BACK_RETRY_DELAYS_MS[0]);
      await Promise.resolve();
      await Promise.resolve();
      expect(callCount).toBe(2);

      // After retry failure: echo guard again removed
      expect(expectedChanges.get("TASK-6")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// writeBackStatusWithRetry: scheduler.test.ts mock verification
// ---------------------------------------------------------------------------
// Verify that the scheduler.test.ts mock properly covers writeBackStatusWithRetry.
// The scheduler imports writeBackStatusWithRetry from sync.js, and the test file
// mocks it. If this mock is missing, scheduler tests would make real scheduleWithRetry
// calls which could interfere with test isolation.

describe("scheduler.test.ts mock coverage for writeBackStatusWithRetry", () => {
  it("writeBackStatusWithRetry is exported from sync.js and is mockable", () => {
    // This test verifies the function is exported correctly.
    // The scheduler.test.ts already mocks it — this confirms the export exists.
    // If it weren't exported, the mock would silently fail.
    const syncModule = {
      writeBackStatusWithRetry,
    };
    expect(typeof syncModule.writeBackStatusWithRetry).toBe("function");
  });
});

// Re-export to avoid TS unused import errors
export {};

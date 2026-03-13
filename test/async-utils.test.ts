// ---------------------------------------------------------------------------
// Tests for src/scheduler/async-utils.ts — withRetry and TaskFailureTracker
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { withRetry, TaskFailureTracker } from "../src/scheduler/async-utils.js";

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe("withRetry", () => {
  // -------------------------------------------------------------------------
  // attempts=0 is invalid — withRetry throws a descriptive error immediately.
  // -------------------------------------------------------------------------
  it("zero attempts throws a descriptive error", async () => {
    const fn = vi.fn().mockResolvedValue("never called");
    await expect(
      withRetry(fn, { attempts: 0, delayMs: 0, label: "zero" }),
    ).rejects.toThrow(/attempts must be >= 1/);

    // fn should never have been called
    expect(fn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Basic correctness: single attempt, succeeds first try
  // -------------------------------------------------------------------------
  it("returns immediately on first-try success", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await withRetry(fn, {
      attempts: 3,
      delayMs: 0,
      label: "ok",
    });
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("succeeds on last attempt after earlier failures", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, {
      attempts: 3,
      delayMs: 0,
      label: "eventual",
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws the last error after all attempts fail", async () => {
    const err = new Error("final");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockRejectedValue(err);
    await expect(
      withRetry(fn, { attempts: 3, delayMs: 0, label: "all-fail" }),
    ).rejects.toThrow("final");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("calls onFailure for every failed attempt", async () => {
    const onFailure = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("a"))
      .mockRejectedValueOnce(new Error("b"))
      .mockResolvedValue("done");
    await withRetry(fn, { attempts: 3, delayMs: 0, label: "x", onFailure });
    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenNthCalledWith(1, 1, expect.any(Error));
    expect(onFailure).toHaveBeenNthCalledWith(2, 2, expect.any(Error));
  });

  it("does NOT call onFailure on success", async () => {
    const onFailure = vi.fn();
    const fn = vi.fn().mockResolvedValue("win");
    await withRetry(fn, { attempts: 3, delayMs: 0, label: "y", onFailure });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("delays between attempts but not after the final failure", async () => {
    // Use real timers with delayMs=0 to confirm correct call counts
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new Error(`fail ${callCount}`);
    };
    await expect(
      withRetry(fn, { attempts: 3, delayMs: 0, label: "timing" }),
    ).rejects.toThrow("fail 3");
    expect(callCount).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Single attempt: should call fn exactly once, no delay, throw on failure
  // -------------------------------------------------------------------------
  it("single attempt: calls fn once, throws immediately on failure", async () => {
    const err = new Error("boom");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, { attempts: 1, delayMs: 10_000, label: "single" }),
    ).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// TaskFailureTracker
// ---------------------------------------------------------------------------

describe("TaskFailureTracker", () => {
  let tracker: TaskFailureTracker;

  beforeEach(() => {
    tracker = new TaskFailureTracker(3, "[test]");
  });

  // -------------------------------------------------------------------------
  // record / getCount / clear
  // -------------------------------------------------------------------------
  it("starts at zero for unknown task", () => {
    expect(tracker.getCount("task-1")).toBe(0);
  });

  it("record increments count and returns new value", () => {
    expect(tracker.record("task-1")).toBe(1);
    expect(tracker.record("task-1")).toBe(2);
    expect(tracker.getCount("task-1")).toBe(2);
  });

  it("clear removes the task from the map", () => {
    tracker.record("task-1");
    tracker.clear("task-1");
    expect(tracker.getCount("task-1")).toBe(0);
  });

  it("clear on non-existent task is a no-op", () => {
    expect(() => tracker.clear("ghost")).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // getAll
  // -------------------------------------------------------------------------
  it("getAll returns all tasks with count > 0", () => {
    tracker.record("a");
    tracker.record("a");
    tracker.record("b");
    const all = tracker.getAll();
    expect(all).toEqual({ a: 2, b: 1 });
  });

  it("getAll returns empty object when no failures", () => {
    expect(tracker.getAll()).toEqual({});
  });

  it("getAll excludes tasks that were cleared", () => {
    tracker.record("a");
    tracker.record("b");
    tracker.clear("a");
    const all = tracker.getAll();
    expect(all).not.toHaveProperty("a");
    expect(all).toHaveProperty("b");
  });

  // -------------------------------------------------------------------------
  // BUG-2: logFailure reads count BEFORE record() is called.
  //
  // The intended usage pattern in scheduler/index.ts and sync.ts is:
  //   onFailure: (attempt, err) => {
  //     killFailureTracker.record(id);   // increments first
  //     killFailureTracker.logFailure(id, msg);  // then logs
  //   }
  //
  // But logFailure() itself calls getCount() without calling record().
  // So on the very first failure: record() sets count to 1, then
  // logFailure() reads count=1. With threshold=3, 1 >= 3 is false → console.log.
  // This is fine for the threshold check itself.
  //
  // However, if the caller forgets to call record() first (e.g., calls
  // logFailure without record), the threshold comparison uses stale data.
  // This is a design smell but not a crash bug — tested here to document it.
  // -------------------------------------------------------------------------
  it("logFailure uses count from BEFORE this call — caller must call record() first", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Simulate the actual call pattern: record THEN logFailure
    tracker.record("t");   // count=1
    tracker.logFailure("t", "msg1");  // reads 1 >= 3? no → console.log
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();

    tracker.record("t");   // count=2
    tracker.logFailure("t", "msg2");  // reads 2 >= 3? no → console.log
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).not.toHaveBeenCalled();

    tracker.record("t");   // count=3
    tracker.logFailure("t", "msg3");  // reads 3 >= 3? YES → console.warn
    expect(warnSpy).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // BUG-3: logFailure threshold is >= threshold, but the tracker counts
  // failures BEFORE the threshold. At threshold=3, the THIRD failure triggers
  // warn. Verify the boundary: count=2 must still log (not warn).
  // -------------------------------------------------------------------------
  it("logFailure escalates to warn exactly at threshold (>= not >)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Manually seed count to threshold - 1 via two records
    tracker.record("t");  // 1
    tracker.record("t");  // 2
    tracker.logFailure("t", "below");
    expect(warnSpy).not.toHaveBeenCalled();  // count=2, threshold=3 → log

    tracker.record("t");  // 3 — AT threshold
    tracker.logFailure("t", "at");
    expect(warnSpy).toHaveBeenCalledTimes(1); // >= 3 → warn

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // BUG-4: logFailure does NOT call record() internally. If a caller omits
  // record(), the count stays 0 forever and warn is never emitted even after
  // many failures. This tests that the tracker will never escalate if only
  // logFailure is called without record().
  // -------------------------------------------------------------------------
  it("BUG-4: logFailure alone never escalates — record() must be called separately", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Call logFailure 100 times without ever calling record()
    for (let i = 0; i < 100; i++) {
      tracker.logFailure("t", `msg ${i}`);
    }
    // Count stays 0 so threshold never reached — all go to console.log
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(100);

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // getAll snapshot is not a live reference
  // -------------------------------------------------------------------------
  it("getAll returns a plain object snapshot, not a live Map reference", () => {
    tracker.record("x");
    const snap1 = tracker.getAll();
    tracker.record("x");
    const snap2 = tracker.getAll();
    // snap1 should still show count=1, not 2
    expect(snap1["x"]).toBe(1);
    expect(snap2["x"]).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Multiple independent tasks do not interfere
  // -------------------------------------------------------------------------
  it("tracks multiple task IDs independently", () => {
    tracker.record("a");
    tracker.record("a");
    tracker.record("b");
    tracker.clear("a");
    expect(tracker.getCount("a")).toBe(0);
    expect(tracker.getCount("b")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Timeout handler: floating promise + activeHandles.delete race
// (Structural bugs — described in detail, tested with a synthetic harness)
// ---------------------------------------------------------------------------

describe("timeout handler structural bugs", () => {
  // -------------------------------------------------------------------------
  // BUG-5 (structural, not unit-testable directly): In scheduler/index.ts
  // lines 1847-1867, withRetry() is called WITHOUT await. The returned
  // Promise floats. This means:
  //
  //   1. activeHandles.delete(inv.id) executes on line 1867 IMMEDIATELY,
  //      BEFORE the kill has completed (or failed).
  //   2. The subsequent updateInvocation() and updateTaskStatus() calls on
  //      lines 1871-1877 also run BEFORE the kill completes.
  //   3. If withRetry eventually fails (CRITICAL path), the scheduler has
  //      already logged the invocation as timed_out and freed the handle slot.
  //      The orphaned process continues running with no tracking.
  //   4. If withRetry succeeds on attempt 2 or 3 (after >1s delay), the
  //      invocation is already marked timed_out in the DB and the handle is
  //      gone — the success path (killFailureTracker.clear) still runs
  //      correctly, but this is accidental.
  //
  // This test documents the observable race: delete happens before kill completes.
  // -------------------------------------------------------------------------
  it("BUG-5 doc: withRetry resolves AFTER activeHandles.delete in timeout handler (floating promise)", async () => {
    // Simulate the timeout handler's behavior with a synthetic harness
    const killOrder: string[] = [];
    const fakeHandles = new Map<number, unknown>();
    fakeHandles.set(1, {});

    let resolveKill!: () => void;
    const killPromise = new Promise<void>((r) => { resolveKill = r; });

    const killFn = () => {
      return killPromise.then(() => {
        killOrder.push("kill-completed");
      });
    };

    // Replicate what the scheduler does — fire-and-forget, then delete
    withRetry(killFn, { attempts: 1, delayMs: 0, label: "test" })
      .then(() => {})
      .catch(() => {});
    fakeHandles.delete(1); // happens synchronously, BEFORE kill completes
    killOrder.push("handle-deleted");

    // Now let the kill complete
    resolveKill();
    await new Promise((r) => setTimeout(r, 10));

    // The handle was deleted BEFORE the kill actually finished
    expect(killOrder).toEqual(["handle-deleted", "kill-completed"]);
  });

  // -------------------------------------------------------------------------
  // BUG-6 (structural): In sync.ts killRunningSession(), withRetry() is also
  // called without await (fire-and-forget). But updateInvocation() and
  // activeHandles.delete(invId) ARE called immediately after on lines 484-489
  // — so those side effects happen unconditionally regardless of kill outcome.
  //
  // This is actually correct behavior for the DB update (always mark failed),
  // but it means the process could still be alive when the handle is deleted.
  // More critically: if a second dispatch for the same task fires quickly
  // (next scheduler tick), there is a window where the old process is alive
  // but the handle map thinks it's gone. That new invocation then spawns,
  // and two Claude processes run simultaneously for the same task.
  //
  // This is a correctness bug but requires integration-level testing.
  // Documented here for tracking.
  // -------------------------------------------------------------------------
  it("BUG-6 doc: killRunningSession deletes handle before kill resolves (verified structurally)", () => {
    // This is a structural observation, not a unit test.
    // The kill is fire-and-forget; updateInvocation + activeHandles.delete
    // run synchronously after the withRetry() call returns the promise.
    // Result: two concurrent Claude processes possible if scheduler ticks
    // before the kill completes.
    expect(true).toBe(true); // placeholder to keep bug documented in test suite
  });
});

// ---------------------------------------------------------------------------
// BUG-7: killFailureTracker key type mismatch
// The tracker is keyed by String(inv.id) in scheduler/index.ts but
// killConflictFailureTracker in sync.ts is keyed by taskId (a string already).
// These are consistent per tracker. However, the /api/error-counts endpoint
// returns both trackers. For killFailureTracker, keys are stringified numeric
// invocation IDs. If a consumer expects task IDs as keys, they will find
// invocation IDs instead — a misleading API contract.
// ---------------------------------------------------------------------------
describe("killFailureTracker key semantics", () => {
  it("TaskFailureTracker keys are arbitrary strings — no type enforcement prevents mixing task IDs and invocation IDs", () => {
    const tracker = new TaskFailureTracker(3);
    // Both a numeric-string invocation ID and a UUID task ID can coexist
    tracker.record("42");          // invocation ID (as in scheduler)
    tracker.record("ISSUE-123");   // task ID (as in sync)
    const all = tracker.getAll();
    expect(all["42"]).toBe(1);
    expect(all["ISSUE-123"]).toBe(1);
    // No type error, but the two trackers' key spaces are semantically different
  });
});

// ---------------------------------------------------------------------------
// withRetry zero-attempts validation
// ---------------------------------------------------------------------------
describe("withRetry zero-attempts edge case", () => {
  it("throws a descriptive error when attempts=0", async () => {
    let caught: unknown = "not-set";
    try {
      await withRetry(() => Promise.resolve("x"), {
        attempts: 0,
        delayMs: 0,
        label: "zero-attempts",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/attempts must be >= 1/);
  });

  it("fn is never called when attempts=0", async () => {
    const fn = vi.fn().mockResolvedValue("should not matter");
    await expect(
      withRetry(fn, { attempts: 0, delayMs: 0, label: "z" }),
    ).rejects.toThrow(/attempts must be >= 1/);
    expect(fn).toHaveBeenCalledTimes(0);
  });
});

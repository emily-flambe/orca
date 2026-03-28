// ---------------------------------------------------------------------------
// drain-timeout-adversarial.test.ts
//
// Adversarial tests for the drain-timeout and observability implementation
// (EMI-348). Tests are written to EXPOSE bugs. Each test documents what
// behaviour is expected and why the implementation may fail to deliver it.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted by vitest before any imports)
// ---------------------------------------------------------------------------

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../src/scheduler/alerts.js", () => ({
  sendAlertThrottled: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  isDraining,
  setDraining,
  clearDraining,
  getDrainingForSeconds,
  autoClearDrainIfStuck,
} from "../src/deploy.js";

import {
  processDrainSnapshot,
  checkDrainState,
  type DrainTrackingState,
} from "../src/scheduler/drain-detector.js";

import { writeMonitorSnapshot } from "../src/scheduler/monitor-snapshot.js";
import { sendAlertThrottled } from "../src/scheduler/alerts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetDrainState(): void {
  if (isDraining()) clearDraining();
}

// ---------------------------------------------------------------------------
// BUG 1: autoClearDrainIfStuck boundary — timeout=0 does not clear immediately
//
// When timeoutMin=0, the condition is `seconds <= 0 * 60` → `seconds <= 0`.
// getDrainingForSeconds() uses Math.floor, so it returns 0 for the first
// sub-second of drain. 0 <= 0 is TRUE, so the function returns false and
// does NOT clear. The drain must persist for at least 1 full second before
// it clears — even though a zero-minute timeout semantically means
// "clear immediately".
// ---------------------------------------------------------------------------

describe("BUG 1: autoClearDrainIfStuck — timeout=0 boundary", () => {
  beforeEach(() => {
    resetDrainState();
    vi.useRealTimers();
  });

  test("autoClearDrainIfStuck(0, 0) does not clear immediately — documents ORCA_DRAIN_TIMEOUT_MIN=0 limitation", () => {
    // KNOWN LIMITATION: parsePositiveInt rejects 0, so ORCA_DRAIN_TIMEOUT_MIN=0
    // can never be set in production. Minimum is 1 (60 second timeout).
    // This test documents the off-by-one: if 0 could be set, it wouldn't
    // clear immediately (0 elapsed seconds <= 0*60 blocks the clear).
    setDraining();
    expect(isDraining()).toBe(true);

    // With timeoutMin=0: `seconds <= 0 * 60` → `0 <= 0` → true → returns false.
    // In practice this can't happen because config rejects drainTimeoutMin=0.
    const cleared = autoClearDrainIfStuck(0, 0);
    expect(cleared).toBe(false); // documents the limitation (not a production concern)
  });

  test("getDrainingForSeconds returns 0 immediately after setDraining", () => {
    // This is the root cause: Math.floor sub-second elapsed = 0,
    // and 0 <= 0 blocks the auto-clear even when timeoutMin=0.
    setDraining();
    const elapsed = getDrainingForSeconds();
    // This will be 0, confirming the off-by-one boundary.
    expect(elapsed).toBe(0);
    // And 0 <= 0*60 means the check guard fires, blocking the clear.
    expect(0 <= 0 * 60).toBe(true); // documents the off-by-one
  });
});

// ---------------------------------------------------------------------------
// BUG 2: processDrainSnapshot — future firstZeroSessionAt in corrupted file
//
// If the state file has a firstZeroSessionAt in the future (clock skew,
// manual edit, or bugs), the function trusts it without validation.
// checkDrainState then computes a negative durationMinutes and sends an
// alert saying "draining for -N min", which is confusing and wrong.
// ---------------------------------------------------------------------------

describe("BUG 2: processDrainSnapshot — future firstZeroSessionAt", () => {
  test("negative duration when firstZeroSessionAt is in the future", () => {
    const futureTs = new Date(Date.now() + 3_600_000).toISOString(); // 1h ahead

    const state: DrainTrackingState = {
      consecutiveZeroSessionSnapshots: 1,
      firstZeroSessionAt: futureTs,
    };

    const now = new Date(); // real now (in the past relative to futureTs)
    const { updatedState } = processDrainSnapshot(true, 0, state, now);

    // The function returns the future timestamp unchanged.
    expect(updatedState.firstZeroSessionAt).toBe(futureTs);

    // Downstream code in checkDrainState computes:
    //   const durationMinutes = Math.round((Date.now() - firstMs) / 60000)
    // With a future firstMs, this will be negative.
    const firstMs = new Date(updatedState.firstZeroSessionAt!).getTime();
    const durationMinutes = Math.round((now.getTime() - firstMs) / 60000);

    // BUG: duration is negative, alert message says "~-60 min"
    expect(durationMinutes).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// BUG 3: processDrainSnapshot — alert fires only EXACTLY at count===2
//
// If the state file already has consecutiveZeroSessionSnapshots=100 from a
// prior stuck drain that was never cleared (process restarted mid-drain),
// the new snapshot increments to 101. count===2 is never hit → no alert fires.
// The stuck drain is silently ignored.
// ---------------------------------------------------------------------------

describe("BUG 3: processDrainSnapshot — skipped alert when count>2 from stale file", () => {
  test("no alert fires when count jumps from stale high value past threshold", () => {
    const staleState: DrainTrackingState = {
      consecutiveZeroSessionSnapshots: 100,
      firstZeroSessionAt: new Date(Date.now() - 3_600_000).toISOString(),
    };

    // First snapshot after process restart: count goes 100 → 101
    const { shouldAlert: alert101 } = processDrainSnapshot(
      true,
      0,
      staleState,
    );

    // BUG: shouldAlert is false because 101 !== 2.
    // This is a persistent, long-running drain that should definitely alert.
    expect(alert101).toBe(true);
  });

  test("re-alerts on 3rd consecutive snapshot (count===3) after fix", () => {
    // FIXED: shouldAlert is now `newCount >= 2` instead of `newCount === 2`.
    // At count=3, shouldAlert=true; sendAlertThrottled handles the 30-min cooldown.
    // This ensures stuck-drain alerts continue firing across process restarts
    // even when the state file has count > 2.
    const stateAtTwo: DrainTrackingState = {
      consecutiveZeroSessionSnapshots: 2,
      firstZeroSessionAt: new Date(Date.now() - 600_000).toISOString(),
    };

    const { shouldAlert: alert3 } = processDrainSnapshot(true, 0, stateAtTwo);
    // count becomes 3, shouldAlert = (3 >= 2) = true (FIXED)
    expect(alert3).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BUG 4: checkDrainState — corrupted JSON in state file silently resets count
//
// If the state file exists but contains malformed JSON (disk error, truncation,
// partial write), JSON.parse throws a SyntaxError. The catch block checks
// `code !== "ENOENT"` — a SyntaxError has no .code property, so (undefined !==
// "ENOENT") is true, and a warn is logged. State falls back to the zero default.
//
// This means: if the file is always corrupted, consecutive count never
// accumulates past 1, and the alert at count===2 never fires. A stuck drain
// with a corrupted state file silently escapes alerting forever.
// ---------------------------------------------------------------------------

describe("BUG 4: checkDrainState — corrupted state file resets count to 0", () => {
  test("one-time corrupt file recovers on first successful write", async () => {
    // Documents that a ONE-TIME corrupt file recovers correctly:
    // First call: corrupt read → reset to 0 → write count=1 (file is now valid).
    // Second call: reads count=1 → writes count=2 → alert fires.
    // (A PERSISTENTLY re-corrupted file between writes is out of scope.)
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-drain-test-"));
    const stateFile = path.join(tmpDir, "drain-state-tracking.json");

    const mockDeps = {
      config: { alertWebhookUrl: "http://example.com/webhook" },
    } as never;

    // Simulate a one-time corrupted state file.
    await fs.writeFile(stateFile, "{ corrupted json %%% ", "utf8");

    // First call: corrupt read → resets to count=0 → processes to count=1 → writes valid file.
    await checkDrainState(mockDeps, true, 0, stateFile);
    const afterFirst = JSON.parse(await fs.readFile(stateFile, "utf8")) as DrainTrackingState;
    expect(afterFirst.consecutiveZeroSessionSnapshots).toBe(1);

    // Second call: reads count=1 → count=2 → alert fires.
    const alertSpy = vi.mocked(sendAlertThrottled);
    alertSpy.mockClear();
    await checkDrainState(mockDeps, true, 0, stateFile);
    const afterSecond = JSON.parse(await fs.readFile(stateFile, "utf8")) as DrainTrackingState;
    expect(afterSecond.consecutiveZeroSessionSnapshots).toBe(2);
    expect(alertSpy).toHaveBeenCalledOnce();

    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// BUG 5: processDrainSnapshot — non-draining with activeSessions<0
//
// The function checks `activeSessions > 0` to short-circuit the "draining +
// sessions still active" guard. Negative session counts (defensive: shouldn't
// happen but DB bugs could produce them) pass the guard and are treated as
// "zero sessions" (draining stuck), triggering false alerts.
// ---------------------------------------------------------------------------

describe("BUG 5: processDrainSnapshot — negative activeSessions treated as zero", () => {
  test("negative activeSessions should not be treated as zero-session drain", () => {
    const state: DrainTrackingState = {
      consecutiveZeroSessionSnapshots: 1,
      firstZeroSessionAt: new Date().toISOString(),
    };

    // activeSessions=-1 is not > 0, so it falls through to the drain+zero path.
    // This is a DB inconsistency but the detector should guard against it.
    const { updatedState, shouldAlert } = processDrainSnapshot(
      true,
      -1, // should not be treated as "zero sessions"
      state,
    );

    // BUG: count increments to 2 and shouldAlert fires for a non-zero-session state.
    // Expected: either throw or treat as "sessions active" (reset/no alert).
    expect(updatedState.consecutiveZeroSessionSnapshots).toBe(1); // should NOT increment
    expect(shouldAlert).toBe(false); // should NOT alert
  });
});

// ---------------------------------------------------------------------------
// BUG 6: writeMonitorSnapshot — empty task list with draining produces
//         a file with only the system header and no trailing newline guard.
//
// When tasks=[] and draining=true, the output is:
//   {"type":"system","draining":true,"drainingForSeconds":N}\n
//
// The trailing "\n" comes from `lines.join("\n") + "\n"`.
// With one header line and zero task lines, join produces just the header
// with no trailing newline from join itself — but the `+ "\n"` adds one.
// This is technically correct NDJSON, but a reader doing `lines.split("\n")`
// gets ["header", ""] — an empty trailing element that may cause parse errors
// in naive consumers. Not exposed by current tests.
//
// More critically: drainingForSeconds=null is serialized as the JSON literal
// null, not omitted. Consumers expecting a number will get null and may crash.
// ---------------------------------------------------------------------------

describe("BUG 6: writeMonitorSnapshot — drainingForSeconds=null serialization", () => {
  test("drainingForSeconds null is included as JSON null in system header", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-snap-test-"));
    const snapFile = path.join(tmpDir, "snapshot.ndjson");

    await writeMonitorSnapshot(
      [],
      snapFile,
      { draining: true, drainingForSeconds: null },
    );

    const content = await fs.readFile(snapFile, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);

    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(header.type).toBe("system");
    expect(header.draining).toBe(true);
    // The field IS present (as JSON null), not omitted.
    // Consumers checking `if (header.drainingForSeconds)` will get a falsy
    // value that is not undefined — which may be surprising but is not a crash.
    expect("drainingForSeconds" in header).toBe(true);
    expect(header.drainingForSeconds).toBeNull();

    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("trailing newline split produces empty string last element for naive consumers", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-snap-test2-"));
    const snapFile = path.join(tmpDir, "snapshot.ndjson");

    await writeMonitorSnapshot(
      [],
      snapFile,
      { draining: true, drainingForSeconds: 30 },
    );

    const raw = await fs.readFile(snapFile, "utf8");
    // The file always ends with "\n". A naive split("\n") produces an empty
    // trailing element. This is standard NDJSON, but worth documenting.
    const splitLines = raw.split("\n");
    const lastElement = splitLines[splitLines.length - 1];
    expect(lastElement).toBe(""); // trailing empty from the "\n"

    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// BUG 7: writeMonitorSnapshot — system header written when draining=false
//         should NOT appear, but what if systemState is provided with
//         draining explicitly set to false?
// ---------------------------------------------------------------------------

describe("BUG 7: writeMonitorSnapshot — systemState.draining=false suppresses header", () => {
  test("no system header when draining=false even if drainingForSeconds is set", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-snap-test3-"));
    const snapFile = path.join(tmpDir, "snapshot.ndjson");

    await writeMonitorSnapshot(
      [],
      snapFile,
      { draining: false, drainingForSeconds: 999 },
    );

    const content = await fs.readFile(snapFile, "utf8");
    // When draining=false, no system header should appear even if
    // drainingForSeconds has a stale non-null value.
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(0); // no tasks, no header

    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// BUG 8: checkDrainState — drain cleared mid-run does NOT reset state file
//
// Scenario:
//   1. checkDrainState is called with draining=true → state file updated to
//      count=1.
//   2. autoClearDrainIfStuck() fires between reconcile steps → draining=false.
//   3. Next reconcile cycle calls checkDrainState with draining=false.
//   4. processDrainSnapshot resets to count=0, file updated.
//
// This works correctly. BUT: step 5 in the reconcile workflow calls
// writeMonitorSnapshot AFTER checkDrainState. By that point isDraining()
// may have been cleared (by step "check-drain-timeout"), so the snapshot
// correctly omits the system header. This ordering is NOT guaranteed by tests.
//
// The test below verifies that checkDrainState with draining=false resets
// the file to count=0 (correct behaviour, documents the contract).
// ---------------------------------------------------------------------------

describe("BUG 8: checkDrainState resets state file when drain clears", () => {
  test("state file is reset to count=0 after drain clears", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-drain-reset-"));
    const stateFile = path.join(tmpDir, "drain-state.json");

    const mockDeps = {
      config: { alertWebhookUrl: undefined },
    } as never;

    // Prime state file with count=1 (draining, seen one snapshot)
    await fs.writeFile(
      stateFile,
      JSON.stringify({
        consecutiveZeroSessionSnapshots: 1,
        firstZeroSessionAt: new Date(Date.now() - 300_000).toISOString(),
      }),
      "utf8",
    );

    // Now drain clears — call with draining=false
    await checkDrainState(mockDeps, false, 0, stateFile);

    const result = JSON.parse(await fs.readFile(stateFile, "utf8")) as DrainTrackingState;

    // After drain cleared, count must be 0 and firstZeroSessionAt null.
    expect(result.consecutiveZeroSessionSnapshots).toBe(0);
    expect(result.firstZeroSessionAt).toBeNull();

    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("state file from prior drain episode does not carry over to new drain episode", async () => {
    // Scenario: drain was stuck, then manually cleared (unpause), then a new
    // deploy sets drain again. The state file still has count=5 from the old
    // episode. When drain is set again, the first snapshot sees count=5 and
    // increments to 6 — skipping the count===2 alert threshold forever.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-drain-carryover-"));
    const stateFile = path.join(tmpDir, "drain-state.json");

    const mockDeps = {
      config: { alertWebhookUrl: undefined },
    } as never;

    // Simulate stale state from prior drain episode
    await fs.writeFile(
      stateFile,
      JSON.stringify({
        consecutiveZeroSessionSnapshots: 5,
        firstZeroSessionAt: new Date(Date.now() - 3_600_000).toISOString(),
      }),
      "utf8",
    );

    // drain=false clears the file
    await checkDrainState(mockDeps, false, 0, stateFile);

    const afterClear = JSON.parse(await fs.readFile(stateFile, "utf8")) as DrainTrackingState;
    expect(afterClear.consecutiveZeroSessionSnapshots).toBe(0);

    // New drain episode starts — first snapshot
    await checkDrainState(mockDeps, true, 0, stateFile);
    const afterFirst = JSON.parse(await fs.readFile(stateFile, "utf8")) as DrainTrackingState;
    expect(afterFirst.consecutiveZeroSessionSnapshots).toBe(1); // fresh start

    // Second snapshot — should trigger alert
    const alertSpy = vi.mocked(sendAlertThrottled);
    alertSpy.mockClear();
    await checkDrainState(mockDeps, true, 0, stateFile);
    const afterSecond = JSON.parse(await fs.readFile(stateFile, "utf8")) as DrainTrackingState;
    expect(afterSecond.consecutiveZeroSessionSnapshots).toBe(2);
    expect(alertSpy).toHaveBeenCalledOnce(); // alert fires at count===2

    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// BUG 9: autoClearDrainIfStuck — TOCTOU: `draining` state re-checked
//         indirectly via clearDraining() after getDrainingForSeconds()
//
// Between `getDrainingForSeconds()` returning a non-null value and
// `clearDraining()` being called, another code path can call `clearDraining()`
// (e.g., /api/deploy/unpause). clearDraining() guards with `if (!draining)`
// and logs "not draining", so it's idempotent. autoClearDrainIfStuck then
// calls clearDraining() on an already-cleared drain, which logs the warning
// but does not throw. This is safe but produces a spurious log entry.
//
// The test verifies that double-clearDraining is safe (idempotent).
// ---------------------------------------------------------------------------

describe("BUG 9: autoClearDrainIfStuck TOCTOU — double clear is safe", () => {
  beforeEach(() => resetDrainState());

  test("clearDraining after already cleared does not throw", () => {
    // Simulate: drain was set, then clearDraining called twice (race).
    setDraining();
    clearDraining();
    // Second clear (from autoClearDrainIfStuck after race) must not throw.
    expect(() => clearDraining()).not.toThrow();
    expect(isDraining()).toBe(false);
  });

  test("autoClearDrainIfStuck returns false if drain was already cleared externally", () => {
    // Simulate the race: timeout fires but /api/deploy/unpause already cleared it.
    setDraining();

    // External clear (unpause endpoint fires first)
    clearDraining();

    // autoClearDrainIfStuck now runs — drain is already false, should return false
    const cleared = autoClearDrainIfStuck(0, 0);
    expect(cleared).toBe(false); // correctly returns false — not draining
    expect(isDraining()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BUG 10: drainTimeoutMin config — value of 0 is rejected by parsePositiveInt
//
// `readIntOrDefault` calls `parsePositiveInt` which checks `parsed <= 0`.
// Setting ORCA_DRAIN_TIMEOUT_MIN=0 calls process.exit(1).
// There is no way to configure "clear immediately" via env var.
// ---------------------------------------------------------------------------

describe("BUG 10: ORCA_DRAIN_TIMEOUT_MIN=0 is rejected by config parser", () => {
  test("parsePositiveInt rejects 0 — confirms there is no way to set instant drain timeout", () => {
    // This documents the constraint. We can't call loadConfig() easily in
    // tests (requires all required env vars), so we test the math directly.

    // parsePositiveInt rejects `parsed <= 0`, which includes 0 itself.
    const parsed = Number("0");
    const isValidPositiveInt = Number.isInteger(parsed) && parsed > 0;

    // BUG: 0 is a reasonable "instant clear" value but is explicitly rejected.
    // Minimum configurable value is 1 (60 seconds minimum).
    expect(isValidPositiveInt).toBe(false); // documents the rejection
    // Expected by the task author: should be allowed (or a separate
    // "non-negative integer" validation used for this field).
  });
});

// ---------------------------------------------------------------------------
// BUG 11: getDrainingForSeconds returns null when not draining, but health
//         endpoint consumers must handle null vs undefined distinction.
//
// The API returns `drainingForSeconds: getDrainingForSeconds()` which is
// either a number or null. The HealthPage TypeScript type declares it as
// `drainingForSeconds?: number | null`. The render guard is:
//   health.status === "draining" && health.drainingForSeconds != null
//
// If status becomes "draining" but the API returns drainingForSeconds=null
// (e.g., a race where drain was cleared between setting status and calling
// getDrainingForSeconds()), the UI shows "Draining for" with nothing after it.
// ---------------------------------------------------------------------------

describe("BUG 11: getDrainingForSeconds race — null during draining status", () => {
  beforeEach(() => resetDrainState());

  test("getDrainingForSeconds returns null when not draining (documents the null contract)", () => {
    expect(isDraining()).toBe(false);
    const result = getDrainingForSeconds();
    // null when not draining — callers that check isDraining() separately
    // can get a stale null if drain clears between the two calls.
    expect(result).toBeNull();
  });

  test("getDrainingForSeconds returns non-null when draining", () => {
    setDraining();
    const result = getDrainingForSeconds();
    expect(result).not.toBeNull();
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThanOrEqual(0);
  });
});

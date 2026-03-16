// ---------------------------------------------------------------------------
// Stuck-task monitoring tests (EMI-344)
// ---------------------------------------------------------------------------
//
// Tests for:
//   - updateTrackingState() in src/monitoring/stuck-tasks.ts
//   - loadTrackingState() / saveTrackingState() in src/monitoring/state-file.ts
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  updateTrackingState,
  TRANSIENT_THRESHOLD,
  AWAITING_CI_THRESHOLD,
  SNAPSHOT_INTERVAL_MINUTES,
  TERMINAL_STATUSES,
  type TaskTrackingState,
} from "../src/monitoring/stuck-tasks.js";
import {
  loadTrackingState,
  saveTrackingState,
  DEFAULT_STATE_FILE,
} from "../src/monitoring/state-file.js";

// ---------------------------------------------------------------------------
// Control knobs for the fs/promises mock (used in error-path tests only).
// By default these are null — the mock falls through to real implementations.
// ---------------------------------------------------------------------------

let readFileShouldThrow: Error | null = null;
let writeFileShouldThrow: Error | null = null;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      if (readFileShouldThrow) throw readFileShouldThrow;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.readFile as any)(...args);
    }),
    writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
      if (writeFileShouldThrow) throw writeFileShouldThrow;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.writeFile as any)(...args);
    }),
    mkdir: vi.fn(async (...args: Parameters<typeof actual.mkdir>) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.mkdir as any)(...args);
    }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(taskId: string, status: string, retryCount = 0) {
  return { taskId, status, retryCount };
}

function uniqueTmpPath(label: string): string {
  return join(tmpdir(), `orca-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

// ---------------------------------------------------------------------------
// updateTrackingState
// ---------------------------------------------------------------------------

describe("updateTrackingState", () => {
  test("empty task list returns empty state and no alerts", () => {
    const { newState, alerts } = updateTrackingState({}, []);
    expect(newState).toEqual({});
    expect(alerts).toEqual([]);
  });

  test("new task (not in previous state) starts at consecutiveSnapshots=1", () => {
    const { newState } = updateTrackingState({}, [makeTask("T-1", "running")]);
    expect(newState["T-1"].consecutiveSnapshots).toBe(1);
  });

  test("task with same status increments consecutiveSnapshots", () => {
    const prev: TaskTrackingState = {
      "T-1": { status: "running", firstSeenAt: "2024-01-01T00:00:00.000Z", consecutiveSnapshots: 1, retryCount: 0 },
    };
    const { newState } = updateTrackingState(prev, [makeTask("T-1", "running")]);
    expect(newState["T-1"].consecutiveSnapshots).toBe(2);
  });

  test("task with changed status resets consecutiveSnapshots to 1", () => {
    const prev: TaskTrackingState = {
      "T-1": { status: "running", firstSeenAt: "2024-01-01T00:00:00.000Z", consecutiveSnapshots: 5, retryCount: 0 },
    };
    const now = new Date("2024-06-01T12:00:00.000Z");
    const { newState } = updateTrackingState(prev, [makeTask("T-1", "in_review")], now);
    expect(newState["T-1"].consecutiveSnapshots).toBe(1);
  });

  test("task with changed status updates firstSeenAt to now", () => {
    const prev: TaskTrackingState = {
      "T-1": { status: "running", firstSeenAt: "2024-01-01T00:00:00.000Z", consecutiveSnapshots: 5, retryCount: 0 },
    };
    const now = new Date("2024-06-01T12:00:00.000Z");
    const { newState } = updateTrackingState(prev, [makeTask("T-1", "in_review")], now);
    expect(newState["T-1"].firstSeenAt).toBe("2024-06-01T12:00:00.000Z");
  });

  test("terminal status 'done' is excluded from tracking", () => {
    expect(TERMINAL_STATUSES.has("done")).toBe(true);
    const { newState, alerts } = updateTrackingState({}, [makeTask("T-1", "done")]);
    expect(newState["T-1"]).toBeUndefined();
    expect(alerts).toEqual([]);
  });

  test("terminal status 'failed' is excluded from tracking", () => {
    expect(TERMINAL_STATUSES.has("failed")).toBe(true);
    const { newState, alerts } = updateTrackingState({}, [makeTask("T-1", "failed")]);
    expect(newState["T-1"]).toBeUndefined();
    expect(alerts).toEqual([]);
  });

  test("terminal status 'cancelled' is excluded from tracking", () => {
    expect(TERMINAL_STATUSES.has("cancelled")).toBe(true);
    const { newState, alerts } = updateTrackingState({}, [makeTask("T-1", "cancelled")]);
    expect(newState["T-1"]).toBeUndefined();
    expect(alerts).toEqual([]);
  });

  test("non-transient non-awaiting_ci status 'ready' never generates alerts", () => {
    // Build up many consecutive snapshots for 'ready'
    let state: TaskTrackingState = {};
    let alerts: ReturnType<typeof updateTrackingState>["alerts"] = [];
    for (let i = 0; i < 10; i++) {
      ({ newState: state, alerts } = updateTrackingState(state, [makeTask("T-1", "ready")]));
    }
    expect(alerts).toEqual([]);
    expect(state["T-1"].consecutiveSnapshots).toBe(10);
  });

  test("non-transient non-awaiting_ci status 'backlog' never generates alerts", () => {
    let state: TaskTrackingState = {};
    let alerts: ReturnType<typeof updateTrackingState>["alerts"] = [];
    for (let i = 0; i < 10; i++) {
      ({ newState: state, alerts } = updateTrackingState(state, [makeTask("T-1", "backlog")]));
    }
    expect(alerts).toEqual([]);
  });

  test("'running' task triggers alert at exactly TRANSIENT_THRESHOLD consecutive snapshots", () => {
    // Should be 2
    expect(TRANSIENT_THRESHOLD).toBe(2);

    let state: TaskTrackingState = {};
    // First snapshot — below threshold
    let result = updateTrackingState(state, [makeTask("T-1", "running")]);
    state = result.newState;
    expect(result.alerts).toHaveLength(0);

    // Second snapshot — exactly at threshold
    result = updateTrackingState(state, [makeTask("T-1", "running")]);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].taskId).toBe("T-1");
    expect(result.alerts[0].status).toBe("running");
  });

  test("'dispatched' task triggers alert at exactly TRANSIENT_THRESHOLD consecutive snapshots", () => {
    let state: TaskTrackingState = {};
    let result = updateTrackingState(state, [makeTask("T-1", "dispatched")]);
    state = result.newState;
    expect(result.alerts).toHaveLength(0);

    result = updateTrackingState(state, [makeTask("T-1", "dispatched")]);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].status).toBe("dispatched");
  });

  test("'in_review' task triggers alert at exactly TRANSIENT_THRESHOLD consecutive snapshots", () => {
    let state: TaskTrackingState = {};
    let result = updateTrackingState(state, [makeTask("T-1", "in_review")]);
    state = result.newState;
    expect(result.alerts).toHaveLength(0);

    result = updateTrackingState(state, [makeTask("T-1", "in_review")]);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].status).toBe("in_review");
  });

  test("'awaiting_ci' task does NOT trigger alert at snapshot 2", () => {
    expect(AWAITING_CI_THRESHOLD).toBe(4);
    let state: TaskTrackingState = {};
    let result = updateTrackingState(state, [makeTask("T-1", "awaiting_ci")]);
    state = result.newState;
    result = updateTrackingState(state, [makeTask("T-1", "awaiting_ci")]);
    state = result.newState;
    expect(result.alerts).toHaveLength(0);
  });

  test("'awaiting_ci' task does NOT trigger alert at snapshot 3", () => {
    let state: TaskTrackingState = {};
    let result = updateTrackingState(state, [makeTask("T-1", "awaiting_ci")]);
    state = result.newState;
    result = updateTrackingState(state, [makeTask("T-1", "awaiting_ci")]);
    state = result.newState;
    result = updateTrackingState(state, [makeTask("T-1", "awaiting_ci")]);
    state = result.newState;
    expect(result.alerts).toHaveLength(0);
  });

  test("'awaiting_ci' task triggers alert at exactly AWAITING_CI_THRESHOLD (4) consecutive snapshots", () => {
    let state: TaskTrackingState = {};
    for (let i = 1; i <= 3; i++) {
      const result = updateTrackingState(state, [makeTask("T-1", "awaiting_ci")]);
      state = result.newState;
      expect(result.alerts).toHaveLength(0);
    }
    const result = updateTrackingState(state, [makeTask("T-1", "awaiting_ci")]);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].taskId).toBe("T-1");
    expect(result.alerts[0].status).toBe("awaiting_ci");
    expect(result.alerts[0].consecutiveSnapshots).toBe(4);
  });

  test("alert includes correct durationMinutes (consecutiveSnapshots * SNAPSHOT_INTERVAL_MINUTES)", () => {
    expect(SNAPSHOT_INTERVAL_MINUTES).toBe(15);
    let state: TaskTrackingState = {};
    let result = updateTrackingState(state, [makeTask("T-1", "running")]);
    state = result.newState;
    result = updateTrackingState(state, [makeTask("T-1", "running")]);
    // consecutiveSnapshots = 2, durationMinutes = 2 * 15 = 30
    expect(result.alerts[0].durationMinutes).toBe(2 * SNAPSHOT_INTERVAL_MINUTES);
  });

  test("alert includes retryCount from the task", () => {
    let state: TaskTrackingState = {};
    let result = updateTrackingState(state, [makeTask("T-1", "running", 2)]);
    state = result.newState;
    result = updateTrackingState(state, [makeTask("T-1", "running", 2)]);
    expect(result.alerts[0].retryCount).toBe(2);
  });

  test("firstSeenAt is preserved when status stays the same", () => {
    const firstSeen = "2024-01-01T00:00:00.000Z";
    const prev: TaskTrackingState = {
      "T-1": { status: "running", firstSeenAt: firstSeen, consecutiveSnapshots: 1, retryCount: 0 },
    };
    const { newState } = updateTrackingState(prev, [makeTask("T-1", "running")]);
    expect(newState["T-1"].firstSeenAt).toBe(firstSeen);
  });

  test("firstSeenAt updates when status changes", () => {
    const oldFirst = "2024-01-01T00:00:00.000Z";
    const prev: TaskTrackingState = {
      "T-1": { status: "running", firstSeenAt: oldFirst, consecutiveSnapshots: 3, retryCount: 0 },
    };
    const now = new Date("2024-06-15T10:00:00.000Z");
    const { newState } = updateTrackingState(prev, [makeTask("T-1", "in_review")], now);
    expect(newState["T-1"].firstSeenAt).toBe("2024-06-15T10:00:00.000Z");
    expect(newState["T-1"].firstSeenAt).not.toBe(oldFirst);
  });

  test("tasks not in the new snapshot are dropped from state", () => {
    const prev: TaskTrackingState = {
      "T-1": { status: "running", firstSeenAt: "2024-01-01T00:00:00.000Z", consecutiveSnapshots: 2, retryCount: 0 },
      "T-2": { status: "dispatched", firstSeenAt: "2024-01-01T00:00:00.000Z", consecutiveSnapshots: 1, retryCount: 0 },
    };
    // Only T-2 is in new snapshot; T-1 has disappeared (finished or gone)
    const { newState } = updateTrackingState(prev, [makeTask("T-2", "dispatched")]);
    expect(newState["T-1"]).toBeUndefined();
    expect(newState["T-2"]).toBeDefined();
  });

  test("multiple tasks with different statuses are all tracked in one call", () => {
    const tasks = [
      makeTask("T-1", "running"),
      makeTask("T-2", "awaiting_ci"),
      makeTask("T-3", "done"),
      makeTask("T-4", "ready"),
    ];
    const { newState, alerts } = updateTrackingState({}, tasks);
    expect(Object.keys(newState)).toHaveLength(3); // T-3 (done) excluded
    expect(newState["T-1"].status).toBe("running");
    expect(newState["T-2"].status).toBe("awaiting_ci");
    expect(newState["T-4"].status).toBe("ready");
    expect(newState["T-3"]).toBeUndefined();
    expect(alerts).toEqual([]); // all at snapshot 1, below any threshold
  });

  test("retryCount is updated in the new state when it changes", () => {
    const prev: TaskTrackingState = {
      "T-1": { status: "running", firstSeenAt: "2024-01-01T00:00:00.000Z", consecutiveSnapshots: 1, retryCount: 0 },
    };
    // Task is still running but retryCount increased
    const { newState } = updateTrackingState(prev, [makeTask("T-1", "running", 1)]);
    expect(newState["T-1"].retryCount).toBe(1);
  });

  test("'now' parameter is used for firstSeenAt on first appearance", () => {
    const fixedNow = new Date("2024-03-14T09:26:53.589Z");
    const { newState } = updateTrackingState({}, [makeTask("T-1", "running")], fixedNow);
    expect(newState["T-1"].firstSeenAt).toBe("2024-03-14T09:26:53.589Z");
  });
});

// ---------------------------------------------------------------------------
// loadTrackingState and saveTrackingState
// ---------------------------------------------------------------------------

describe("loadTrackingState", () => {
  test("returns empty object when file doesn't exist (ENOENT)", async () => {
    const path = uniqueTmpPath("nonexistent");
    const state = await loadTrackingState(path);
    expect(state).toEqual({});
  });

  test("DEFAULT_STATE_FILE is a string", () => {
    expect(typeof DEFAULT_STATE_FILE).toBe("string");
    expect(DEFAULT_STATE_FILE.length).toBeGreaterThan(0);
  });

  test("throws on non-ENOENT errors", async () => {
    readFileShouldThrow = Object.assign(new Error("Permission denied"), { code: "EACCES" });
    try {
      await expect(loadTrackingState("/some/path.json")).rejects.toThrow("Permission denied");
    } finally {
      readFileShouldThrow = null;
    }
  });
});

describe("saveTrackingState and loadTrackingState round-trip", () => {
  const tmpPaths: string[] = [];

  afterEach(async () => {
    // Clean up temp files created during tests
    for (const p of tmpPaths) {
      await rm(p, { force: true }).catch(() => undefined);
    }
    tmpPaths.length = 0;
  });

  test("saves and loads state correctly (round-trip)", async () => {
    const path = uniqueTmpPath("roundtrip");
    tmpPaths.push(path);

    const state: TaskTrackingState = {
      "T-1": { status: "running", firstSeenAt: "2024-01-01T00:00:00.000Z", consecutiveSnapshots: 3, retryCount: 1 },
      "T-2": { status: "awaiting_ci", firstSeenAt: "2024-01-02T00:00:00.000Z", consecutiveSnapshots: 2, retryCount: 0 },
    };

    await saveTrackingState(state, path);
    const loaded = await loadTrackingState(path);

    expect(loaded).toEqual(state);
  });

  test("creates the directory if it doesn't exist", async () => {
    const subdir = join(tmpdir(), `orca-test-newdir-${Date.now()}`);
    const path = join(subdir, "nested", "state.json");
    tmpPaths.push(path);

    const state: TaskTrackingState = {
      "T-1": { status: "dispatched", firstSeenAt: "2024-01-01T00:00:00.000Z", consecutiveSnapshots: 1, retryCount: 0 },
    };

    // Should not throw even though the directory doesn't exist
    await expect(saveTrackingState(state, path)).resolves.not.toThrow();

    const loaded = await loadTrackingState(path);
    expect(loaded).toEqual(state);

    // Clean up the subdir tree too
    await rm(subdir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("saves empty state and loads it back correctly", async () => {
    const path = uniqueTmpPath("empty");
    tmpPaths.push(path);

    await saveTrackingState({}, path);
    const loaded = await loadTrackingState(path);
    expect(loaded).toEqual({});
  });

  test("overwrites existing state file", async () => {
    const path = uniqueTmpPath("overwrite");
    tmpPaths.push(path);

    const state1: TaskTrackingState = {
      "T-1": { status: "running", firstSeenAt: "2024-01-01T00:00:00.000Z", consecutiveSnapshots: 1, retryCount: 0 },
    };
    const state2: TaskTrackingState = {
      "T-2": { status: "dispatched", firstSeenAt: "2024-02-01T00:00:00.000Z", consecutiveSnapshots: 2, retryCount: 1 },
    };

    await saveTrackingState(state1, path);
    await saveTrackingState(state2, path);

    const loaded = await loadTrackingState(path);
    expect(loaded).toEqual(state2);
    expect(loaded["T-1"]).toBeUndefined();
  });
});

describe("saveTrackingState error handling", () => {
  test("throws when writeFile fails (non-recoverable)", async () => {
    writeFileShouldThrow = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    try {
      const path = uniqueTmpPath("writefail");
      await expect(
        saveTrackingState(
          { "T-1": { status: "running", firstSeenAt: "2024-01-01T00:00:00.000Z", consecutiveSnapshots: 1, retryCount: 0 } },
          path,
        ),
      ).rejects.toThrow("disk full");
    } finally {
      writeFileShouldThrow = null;
    }
  });
});

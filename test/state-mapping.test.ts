// ---------------------------------------------------------------------------
// State mapping tests — mapLinearStateToOrcaStatus (via resolveConflict) and
// resolveConflict type-based behavior
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import { insertTask, getTask } from "../src/db/queries.js";
import type { TaskStatus } from "../src/db/schema.js";

// ---------------------------------------------------------------------------
// Module mocks — must appear before any dynamic imports
// ---------------------------------------------------------------------------

vi.mock("../src/scheduler/index.js", () => ({
  activeHandles: new Map(),
}));

vi.mock("../src/runner/index.js", () => ({
  killSession: vi.fn().mockResolvedValue(undefined),
  spawnSession: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): OrcaDb {
  return createDb(":memory:");
}

function now(): string {
  return new Date().toISOString();
}

function seedTask(
  db: OrcaDb,
  overrides: Partial<{
    linearIssueId: string;
    orcaStatus: TaskStatus;
    retryCount: number;
    reviewCycleCount: number;
  }> = {},
): string {
  const id = overrides.linearIssueId ?? `SM-${Date.now().toString(36)}`;
  const ts = now();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: "test prompt",
    repoPath: "/tmp/test",
    orcaStatus: overrides.orcaStatus ?? "running",
    priority: 0,
    retryCount: overrides.retryCount ?? 0,
    reviewCycleCount: overrides.reviewCycleCount ?? 0,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

// ===========================================================================
// 1. mapLinearStateToOrcaStatus behavior (tested via resolveConflict)
//
// We exercise each type path by seeding a task whose orcaStatus differs from
// what the mapping would produce, then asserting the conflict-resolution
// outcome.  Where resolveConflict has an explicit handler (backlog, unstarted,
// completed, canceled) the status change is observable.  For types that fall
// through without a matching handler (started→running when task is already
// running, unknown types) the task status is unchanged.
// ===========================================================================

describe("mapLinearStateToOrcaStatus — type mappings via resolveConflict", () => {
  let db: OrcaDb;
  let resolveConflict: typeof import("../src/linear/sync.js").resolveConflict;

  beforeEach(async () => {
    db = freshDb();
    const syncMod = await import("../src/linear/sync.js");
    resolveConflict = syncMod.resolveConflict;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('type "backlog" maps to "backlog" — task is reset to backlog', () => {
    const taskId = seedTask(db, { linearIssueId: "SM-BL-1", orcaStatus: "running" });

    resolveConflict(db, taskId, "Backlog", "backlog");

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("backlog");
  });

  it('type "unstarted" maps to "ready" — task is reset to ready', () => {
    const taskId = seedTask(db, { linearIssueId: "SM-US-1", orcaStatus: "running" });

    resolveConflict(db, taskId, "Todo", "unstarted");

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("ready");
  });

  it('type "started" + name without "review" maps to "running" — no conflict when task is running', () => {
    const taskId = seedTask(db, { linearIssueId: "SM-ST-1", orcaStatus: "running" });

    // mapping: "In Progress" + "started" → "running"; task is already "running" → no-op
    resolveConflict(db, taskId, "In Progress", "started");

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("running");
  });

  it('type "started" + name "In Review" maps to "in_review" (review keyword match)', () => {
    // Seed deploying task — the no-op guard in resolveConflict should fire,
    // leaving status unchanged, proving the mapping produced "in_review".
    const taskId = seedTask(db, { linearIssueId: "SM-REV-1", orcaStatus: "deploying" });

    resolveConflict(db, taskId, "In Review", "started");

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("deploying"); // no-op: deploying + in_review guard
  });

  it('type "started" + name "Code Review" maps to "in_review" (review keyword match)', () => {
    const taskId = seedTask(db, { linearIssueId: "SM-REV-2", orcaStatus: "awaiting_ci" });

    resolveConflict(db, taskId, "Code Review", "started");

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("awaiting_ci"); // no-op: awaiting_ci + in_review guard
  });

  it('type "started" + name "QA Review" maps to "in_review" (review keyword match)', () => {
    const taskId = seedTask(db, { linearIssueId: "SM-REV-3", orcaStatus: "deploying" });

    resolveConflict(db, taskId, "QA Review", "started");

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("deploying"); // no-op: deploying + in_review guard
  });

  it('type "completed" maps to "done" — ready task becomes done', () => {
    const taskId = seedTask(db, { linearIssueId: "SM-DONE-1", orcaStatus: "ready" });

    resolveConflict(db, taskId, "Done", "completed");

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("done");
  });

  it('type "canceled" is handled before mapLinearStateToOrcaStatus — task becomes failed', () => {
    const taskId = seedTask(db, { linearIssueId: "SM-CNCL-1", orcaStatus: "ready" });

    resolveConflict(db, taskId, "Canceled", "canceled");

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("failed");
  });

  it('unknown type returns null — resolveConflict does nothing', () => {
    const taskId = seedTask(db, { linearIssueId: "SM-UNK-1", orcaStatus: "running" });

    resolveConflict(db, taskId, "Custom State", "some_unknown_type");

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("running"); // unchanged — null falls through
  });
});

// ===========================================================================
// 2. resolveConflict — type-based conflict handling
// ===========================================================================

describe("resolveConflict — canceled state", () => {
  let db: OrcaDb;
  let resolveConflict: typeof import("../src/linear/sync.js").resolveConflict;

  beforeEach(async () => {
    db = freshDb();
    const syncMod = await import("../src/linear/sync.js");
    resolveConflict = syncMod.resolveConflict;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("running task + canceled → failed", () => {
    const taskId = seedTask(db, { linearIssueId: "RC-CNCL-1", orcaStatus: "running" });

    resolveConflict(db, taskId, "Canceled", "canceled");

    expect(getTask(db, taskId)!.orcaStatus).toBe("failed");
  });

  it("ready task + canceled → failed", () => {
    const taskId = seedTask(db, { linearIssueId: "RC-CNCL-2", orcaStatus: "ready" });

    resolveConflict(db, taskId, "Canceled", "canceled");

    expect(getTask(db, taskId)!.orcaStatus).toBe("failed");
  });

  it("done task + canceled → failed", () => {
    const taskId = seedTask(db, { linearIssueId: "RC-CNCL-3", orcaStatus: "done" });

    resolveConflict(db, taskId, "Canceled", "canceled");

    expect(getTask(db, taskId)!.orcaStatus).toBe("failed");
  });

  it("in_review task + canceled → failed", () => {
    const taskId = seedTask(db, { linearIssueId: "RC-CNCL-4", orcaStatus: "in_review" });

    resolveConflict(db, taskId, "Canceled", "canceled");

    expect(getTask(db, taskId)!.orcaStatus).toBe("failed");
  });

  it("task not in DB + canceled → no error (early return)", () => {
    expect(() => {
      resolveConflict(db, "NONEXISTENT", "Canceled", "canceled");
    }).not.toThrow();
  });
});

describe("resolveConflict — backlog state resets task", () => {
  let db: OrcaDb;
  let resolveConflict: typeof import("../src/linear/sync.js").resolveConflict;

  beforeEach(async () => {
    db = freshDb();
    const syncMod = await import("../src/linear/sync.js");
    resolveConflict = syncMod.resolveConflict;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("running task + backlog → backlog, counters zeroed", () => {
    const taskId = seedTask(db, {
      linearIssueId: "RC-BL-1",
      orcaStatus: "running",
      retryCount: 3,
      reviewCycleCount: 2,
    });

    resolveConflict(db, taskId, "Backlog", "backlog");

    const task = getTask(db, taskId)!;
    expect(task.orcaStatus).toBe("backlog");
    expect(task.retryCount).toBe(0);
    expect(task.reviewCycleCount).toBe(0);
  });

  it("done task + backlog → backlog, counters zeroed", () => {
    const taskId = seedTask(db, {
      linearIssueId: "RC-BL-2",
      orcaStatus: "done",
      retryCount: 2,
    });

    resolveConflict(db, taskId, "Backlog", "backlog");

    const task = getTask(db, taskId)!;
    expect(task.orcaStatus).toBe("backlog");
    expect(task.retryCount).toBe(0);
  });

  it("backlog task + backlog → no-op (statuses match)", () => {
    const taskId = seedTask(db, { linearIssueId: "RC-BL-3", orcaStatus: "backlog" });

    resolveConflict(db, taskId, "Backlog", "backlog");

    expect(getTask(db, taskId)!.orcaStatus).toBe("backlog");
  });
});

describe("resolveConflict — unstarted state resets task to ready", () => {
  let db: OrcaDb;
  let resolveConflict: typeof import("../src/linear/sync.js").resolveConflict;

  beforeEach(async () => {
    db = freshDb();
    const syncMod = await import("../src/linear/sync.js");
    resolveConflict = syncMod.resolveConflict;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("running task + unstarted → ready, counters zeroed", () => {
    const taskId = seedTask(db, {
      linearIssueId: "RC-US-1",
      orcaStatus: "running",
      retryCount: 5,
      reviewCycleCount: 3,
    });

    resolveConflict(db, taskId, "Todo", "unstarted");

    const task = getTask(db, taskId)!;
    expect(task.orcaStatus).toBe("ready");
    expect(task.retryCount).toBe(0);
    expect(task.reviewCycleCount).toBe(0);
  });

  it("done task + unstarted → ready, counters zeroed", () => {
    const taskId = seedTask(db, {
      linearIssueId: "RC-US-2",
      orcaStatus: "done",
      retryCount: 1,
    });

    resolveConflict(db, taskId, "Todo", "unstarted");

    const task = getTask(db, taskId)!;
    expect(task.orcaStatus).toBe("ready");
    expect(task.retryCount).toBe(0);
  });

  it("in_review task + unstarted → ready", () => {
    const taskId = seedTask(db, { linearIssueId: "RC-US-3", orcaStatus: "in_review" });

    resolveConflict(db, taskId, "Todo", "unstarted");

    expect(getTask(db, taskId)!.orcaStatus).toBe("ready");
  });

  it("changes_requested task + unstarted → ready", () => {
    const taskId = seedTask(db, { linearIssueId: "RC-US-4", orcaStatus: "changes_requested" });

    resolveConflict(db, taskId, "Todo", "unstarted");

    expect(getTask(db, taskId)!.orcaStatus).toBe("ready");
  });

  it("failed task + unstarted → ready", () => {
    const taskId = seedTask(db, { linearIssueId: "RC-US-5", orcaStatus: "failed" });

    resolveConflict(db, taskId, "Todo", "unstarted");

    expect(getTask(db, taskId)!.orcaStatus).toBe("ready");
  });

  it("ready task + unstarted → no-op (statuses match)", () => {
    const taskId = seedTask(db, { linearIssueId: "RC-US-6", orcaStatus: "ready" });

    resolveConflict(db, taskId, "Todo", "unstarted");

    expect(getTask(db, taskId)!.orcaStatus).toBe("ready");
  });
});

describe("resolveConflict — completed state transitions", () => {
  let db: OrcaDb;
  let resolveConflict: typeof import("../src/linear/sync.js").resolveConflict;

  beforeEach(async () => {
    db = freshDb();
    const syncMod = await import("../src/linear/sync.js");
    resolveConflict = syncMod.resolveConflict;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ready task + completed → done", () => {
    const taskId = seedTask(db, { linearIssueId: "RC-COMP-1", orcaStatus: "ready" });

    resolveConflict(db, taskId, "Done", "completed");

    expect(getTask(db, taskId)!.orcaStatus).toBe("done");
  });

  it("in_review task + completed → done (human override)", () => {
    const taskId = seedTask(db, { linearIssueId: "RC-COMP-2", orcaStatus: "in_review" });

    resolveConflict(db, taskId, "Done", "completed");

    expect(getTask(db, taskId)!.orcaStatus).toBe("done");
  });

  it("deploying task + completed → done (human override, skip monitoring)", () => {
    const taskId = seedTask(db, { linearIssueId: "RC-COMP-3", orcaStatus: "deploying" });

    resolveConflict(db, taskId, "Done", "completed");

    expect(getTask(db, taskId)!.orcaStatus).toBe("done");
  });

  it("awaiting_ci task + completed → done (human override, skip CI gate)", () => {
    const taskId = seedTask(db, { linearIssueId: "RC-COMP-4", orcaStatus: "awaiting_ci" });

    resolveConflict(db, taskId, "Done", "completed");

    expect(getTask(db, taskId)!.orcaStatus).toBe("done");
  });

  it("done task + completed → no-op (statuses already match)", () => {
    const taskId = seedTask(db, { linearIssueId: "RC-COMP-5", orcaStatus: "done" });

    resolveConflict(db, taskId, "Done", "completed");

    expect(getTask(db, taskId)!.orcaStatus).toBe("done");
  });
});

describe("resolveConflict — started/in_review state no-ops", () => {
  let db: OrcaDb;
  let resolveConflict: typeof import("../src/linear/sync.js").resolveConflict;

  beforeEach(async () => {
    db = freshDb();
    const syncMod = await import("../src/linear/sync.js");
    resolveConflict = syncMod.resolveConflict;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deploying task + started/In Review → no-op (stays deploying)", () => {
    const taskId = seedTask(db, { linearIssueId: "RC-NOOP-1", orcaStatus: "deploying" });

    resolveConflict(db, taskId, "In Review", "started");

    expect(getTask(db, taskId)!.orcaStatus).toBe("deploying");
  });

  it("awaiting_ci task + started/In Review → no-op (stays awaiting_ci)", () => {
    const taskId = seedTask(db, { linearIssueId: "RC-NOOP-2", orcaStatus: "awaiting_ci" });

    resolveConflict(db, taskId, "In Review", "started");

    expect(getTask(db, taskId)!.orcaStatus).toBe("awaiting_ci");
  });

  it("deploying task + started/Code Review → no-op (review keyword fires guard)", () => {
    const taskId = seedTask(db, { linearIssueId: "RC-NOOP-3", orcaStatus: "deploying" });

    resolveConflict(db, taskId, "Code Review", "started");

    expect(getTask(db, taskId)!.orcaStatus).toBe("deploying");
  });

  it("awaiting_ci task + started/QA Review → no-op (review keyword fires guard)", () => {
    const taskId = seedTask(db, { linearIssueId: "RC-NOOP-4", orcaStatus: "awaiting_ci" });

    resolveConflict(db, taskId, "QA Review", "started");

    expect(getTask(db, taskId)!.orcaStatus).toBe("awaiting_ci");
  });

  it("running task + started/In Progress → no-op (statuses match)", () => {
    const taskId = seedTask(db, { linearIssueId: "RC-NOOP-5", orcaStatus: "running" });

    resolveConflict(db, taskId, "In Progress", "started");

    expect(getTask(db, taskId)!.orcaStatus).toBe("running");
  });

  it("in_review task + started/In Review → no-op (statuses match)", () => {
    const taskId = seedTask(db, { linearIssueId: "RC-NOOP-6", orcaStatus: "in_review" });

    resolveConflict(db, taskId, "In Review", "started");

    expect(getTask(db, taskId)!.orcaStatus).toBe("in_review");
  });
});

describe("resolveConflict — non-existent task", () => {
  let db: OrcaDb;
  let resolveConflict: typeof import("../src/linear/sync.js").resolveConflict;

  beforeEach(async () => {
    db = freshDb();
    const syncMod = await import("../src/linear/sync.js");
    resolveConflict = syncMod.resolveConflict;
  });

  it("returns without error when task does not exist", () => {
    expect(() => {
      resolveConflict(db, "GHOST-TASK", "Todo", "unstarted");
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Unit tests for mapLinearStateToOrcaStatus and resolveConflict (EMI-204)
// Type-based state mapping replacing hardcoded name comparisons.
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import { insertTask, getTask } from "../src/db/queries.js";
import type { TaskStatus } from "../src/db/schema.js";

// ---------------------------------------------------------------------------
// Mocks (same as linear-integration.test.ts)
// ---------------------------------------------------------------------------

vi.mock("../src/scheduler/index.js", () => ({
  activeHandles: new Map(),
}));

vi.mock("../src/runner/index.js", () => ({
  killSession: vi.fn().mockResolvedValue({}),
  spawnSession: vi.fn(),
}));

vi.mock("../src/github/index.js", () => ({
  closePrsForCanceledTask: vi.fn(),
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
  id: string,
  status: TaskStatus,
): void {
  const ts = now();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: "test",
    repoPath: "/tmp/repo",
    orcaStatus: status,
    priority: 0,
    retryCount: 0,
    createdAt: ts,
    updatedAt: ts,
  });
}

// ===========================================================================
// mapLinearStateToOrcaStatus — unit tests
// ===========================================================================

describe("mapLinearStateToOrcaStatus", () => {
  let mapLinearStateToOrcaStatus: typeof import("../src/linear/sync.js").mapLinearStateToOrcaStatus;

  beforeEach(async () => {
    const mod = await import("../src/linear/sync.js");
    mapLinearStateToOrcaStatus = mod.mapLinearStateToOrcaStatus;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- type-based mapping ---

  test("type=backlog → backlog", () => {
    expect(mapLinearStateToOrcaStatus("Backlog", "backlog")).toBe("backlog");
  });

  test("type=backlog, custom name → backlog", () => {
    expect(mapLinearStateToOrcaStatus("My Icebox", "backlog")).toBe("backlog");
  });

  test("type=unstarted → ready", () => {
    expect(mapLinearStateToOrcaStatus("Todo", "unstarted")).toBe("ready");
  });

  test("type=unstarted, custom name → ready", () => {
    expect(mapLinearStateToOrcaStatus("Up Next", "unstarted")).toBe("ready");
  });

  test("type=started, name without review → running", () => {
    expect(mapLinearStateToOrcaStatus("In Progress", "started")).toBe("running");
  });

  test("type=started, name without review, custom → running", () => {
    expect(mapLinearStateToOrcaStatus("Working", "started")).toBe("running");
  });

  test("type=started, name='In Review' → in_review", () => {
    expect(mapLinearStateToOrcaStatus("In Review", "started")).toBe("in_review");
  });

  test("type=started, name='Code Review' → in_review", () => {
    expect(mapLinearStateToOrcaStatus("Code Review", "started")).toBe("in_review");
  });

  test("type=started, name='QA Review' → in_review", () => {
    expect(mapLinearStateToOrcaStatus("QA Review", "started")).toBe("in_review");
  });

  test("type=started, name='review' (lowercase) → in_review (case-insensitive)", () => {
    expect(mapLinearStateToOrcaStatus("review", "started")).toBe("in_review");
  });

  test("type=started, name='REVIEW' (uppercase) → in_review", () => {
    expect(mapLinearStateToOrcaStatus("REVIEW", "started")).toBe("in_review");
  });

  test("type=completed → done", () => {
    expect(mapLinearStateToOrcaStatus("Done", "completed")).toBe("done");
  });

  test("type=completed, custom name → done", () => {
    expect(mapLinearStateToOrcaStatus("Shipped", "completed")).toBe("done");
  });

  test("type=canceled → null", () => {
    expect(mapLinearStateToOrcaStatus("Canceled", "canceled")).toBeNull();
  });

  test("type=canceled, custom name → null", () => {
    expect(mapLinearStateToOrcaStatus("Won't Do", "canceled")).toBeNull();
  });

  test("unknown type → null", () => {
    expect(mapLinearStateToOrcaStatus("Whatever", "triage")).toBeNull();
  });

  // --- override scenarios ---

  test("override takes precedence over type mapping", () => {
    const overrides = new Map<string, TaskStatus>([
      ["My Review", "in_review"],
    ]);
    // type=unstarted would normally → "ready", but override wins
    expect(mapLinearStateToOrcaStatus("My Review", "unstarted", overrides)).toBe("in_review");
  });

  test("override for started type state (rename running → running, no change)", () => {
    const overrides = new Map<string, TaskStatus>([
      ["In Progress", "running"],
    ]);
    expect(mapLinearStateToOrcaStatus("In Progress", "started", overrides)).toBe("running");
  });

  test("override maps review-named state to running (overrides heuristic)", () => {
    // Workspace has "In Review" as their dev state that should map to running
    const overrides = new Map<string, TaskStatus>([
      ["In Review", "running"],
    ]);
    expect(mapLinearStateToOrcaStatus("In Review", "started", overrides)).toBe("running");
  });

  test("override for unknown state name → falls through to type mapping", () => {
    const overrides = new Map<string, TaskStatus>([
      ["Something Else", "in_review"],
    ]);
    // "In Progress" is not in overrides → falls through to type=started without /review/ → running
    expect(mapLinearStateToOrcaStatus("In Progress", "started", overrides)).toBe("running");
  });

  test("empty overrides map behaves like no overrides", () => {
    const overrides = new Map<string, TaskStatus>();
    expect(mapLinearStateToOrcaStatus("Backlog", "backlog", overrides)).toBe("backlog");
    expect(mapLinearStateToOrcaStatus("In Progress", "started", overrides)).toBe("running");
  });

  test("override for canceled type → overrides null return", () => {
    const overrides = new Map<string, TaskStatus>([
      ["Canceled", "failed"],
    ]);
    // Override wins even for canceled type
    expect(mapLinearStateToOrcaStatus("Canceled", "canceled", overrides)).toBe("failed");
  });
});

// ===========================================================================
// resolveConflict — type-based tests
// ===========================================================================

describe("resolveConflict — type-based", () => {
  let db: OrcaDb;
  let resolveConflict: typeof import("../src/linear/sync.js").resolveConflict;

  beforeEach(async () => {
    db = freshDb();
    const mod = await import("../src/linear/sync.js");
    resolveConflict = mod.resolveConflict;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("type=canceled → task becomes failed", () => {
    seedTask(db, "T-1", "running");
    resolveConflict(db, "T-1", "Canceled", "canceled");
    expect(getTask(db, "T-1")!.orcaStatus).toBe("failed");
  });

  test("type=canceled with custom name → task becomes failed", () => {
    seedTask(db, "T-2", "ready");
    resolveConflict(db, "T-2", "Won't Do", "canceled");
    expect(getTask(db, "T-2")!.orcaStatus).toBe("failed");
  });

  test("type=backlog → task resets to backlog", () => {
    seedTask(db, "T-3", "running");
    resolveConflict(db, "T-3", "Backlog", "backlog");
    const task = getTask(db, "T-3")!;
    expect(task.orcaStatus).toBe("backlog");
    expect(task.retryCount).toBe(0);
  });

  test("type=backlog with custom name → task resets to backlog", () => {
    seedTask(db, "T-4", "done");
    resolveConflict(db, "T-4", "Ice Box", "backlog");
    expect(getTask(db, "T-4")!.orcaStatus).toBe("backlog");
  });

  test("type=unstarted → task resets to ready", () => {
    seedTask(db, "T-5", "running");
    resolveConflict(db, "T-5", "Todo", "unstarted");
    const task = getTask(db, "T-5")!;
    expect(task.orcaStatus).toBe("ready");
    expect(task.retryCount).toBe(0);
  });

  test("type=unstarted with custom name → task resets to ready", () => {
    seedTask(db, "T-6", "done");
    resolveConflict(db, "T-6", "Up Next", "unstarted");
    expect(getTask(db, "T-6")!.orcaStatus).toBe("ready");
  });

  test("ready, type=completed → task becomes done", () => {
    seedTask(db, "T-7", "ready");
    resolveConflict(db, "T-7", "Done", "completed");
    expect(getTask(db, "T-7")!.orcaStatus).toBe("done");
  });

  test("ready, type=completed with custom name → task becomes done", () => {
    seedTask(db, "T-8", "ready");
    resolveConflict(db, "T-8", "Shipped", "completed");
    expect(getTask(db, "T-8")!.orcaStatus).toBe("done");
  });

  test("in_review, type=completed → task becomes done (human override)", () => {
    seedTask(db, "T-9", "in_review");
    resolveConflict(db, "T-9", "Done", "completed");
    expect(getTask(db, "T-9")!.orcaStatus).toBe("done");
  });

  test("deploying, Linear in_review state → no-op", () => {
    seedTask(db, "T-10", "deploying");
    resolveConflict(db, "T-10", "In Review", "started");
    expect(getTask(db, "T-10")!.orcaStatus).toBe("deploying");
  });

  test("deploying, custom review name → no-op", () => {
    seedTask(db, "T-11", "deploying");
    resolveConflict(db, "T-11", "Code Review", "started");
    expect(getTask(db, "T-11")!.orcaStatus).toBe("deploying");
  });

  test("awaiting_ci, Linear in_review state → no-op", () => {
    seedTask(db, "T-12", "awaiting_ci");
    resolveConflict(db, "T-12", "In Review", "started");
    expect(getTask(db, "T-12")!.orcaStatus).toBe("awaiting_ci");
  });

  test("deploying, type=completed → task becomes done", () => {
    seedTask(db, "T-13", "deploying");
    resolveConflict(db, "T-13", "Done", "completed");
    expect(getTask(db, "T-13")!.orcaStatus).toBe("done");
  });

  test("awaiting_ci, type=completed → task becomes done", () => {
    seedTask(db, "T-14", "awaiting_ci");
    resolveConflict(db, "T-14", "Done", "completed");
    expect(getTask(db, "T-14")!.orcaStatus).toBe("done");
  });

  test("no conflict when running, type=started non-review → no change", () => {
    seedTask(db, "T-15", "running");
    resolveConflict(db, "T-15", "In Progress", "started");
    expect(getTask(db, "T-15")!.orcaStatus).toBe("running");
  });

  test("no conflict when in_review, Linear in_review state → no change", () => {
    seedTask(db, "T-16", "in_review");
    resolveConflict(db, "T-16", "In Review", "started");
    expect(getTask(db, "T-16")!.orcaStatus).toBe("in_review");
  });

  // --- with overrides ---

  test("override maps custom name to in_review, deploying + that state → no-op", () => {
    const overrides = new Map<string, TaskStatus>([["Dev Complete", "in_review"]]);
    seedTask(db, "T-17", "deploying");
    resolveConflict(db, "T-17", "Dev Complete", "started", overrides);
    expect(getTask(db, "T-17")!.orcaStatus).toBe("deploying");
  });

  test("override maps custom canceled name to failed, ready task → failed", () => {
    // Override for 'Won\\'t Fix' which has type canceled
    const overrides = new Map<string, TaskStatus>([["Won't Fix", "failed"]]);
    seedTask(db, "T-18", "ready");
    // type=canceled is caught before mapLinearStateToOrcaStatus, override doesn't help here
    // This tests the cancelation path still works with overrides present
    resolveConflict(db, "T-18", "Won't Fix", "canceled", overrides);
    expect(getTask(db, "T-18")!.orcaStatus).toBe("failed");
  });

  test("nonexistent task → no-op (no throw)", () => {
    expect(() =>
      resolveConflict(db, "NONEXISTENT", "Todo", "unstarted"),
    ).not.toThrow();
  });
});

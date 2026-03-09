// ---------------------------------------------------------------------------
// EMI-204 — Type-based state mapping tests
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import { insertTask, getTask } from "../src/db/queries.js";
import type { TaskStatus } from "../src/db/schema.js";

// Mock scheduler and runner so resolveConflict doesn't need real deps
vi.mock("../src/scheduler/index.js", () => ({
  activeHandles: new Map(),
}));

vi.mock("../src/runner/index.js", () => ({
  killSession: vi.fn().mockResolvedValue({}),
  spawnSession: vi.fn(),
}));

vi.mock("../src/github/index.js", () => ({
  closePrsForCanceledTask: vi.fn().mockResolvedValue(undefined),
}));

function freshDb(): OrcaDb {
  return createDb(":memory:");
}

function now(): string {
  return new Date().toISOString();
}

function seedTask(db: OrcaDb, id: string, status: TaskStatus): void {
  const ts = now();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: "test",
    repoPath: "/tmp/test",
    orcaStatus: status,
    priority: 0,
    retryCount: 0,
    createdAt: ts,
    updatedAt: ts,
  });
}

// ===========================================================================
// mapLinearStateToOrcaStatus — direct unit tests
// ===========================================================================

describe("EMI-204 — mapLinearStateToOrcaStatus", () => {
  let mapLinearStateToOrcaStatus: typeof import("../src/linear/sync.js").mapLinearStateToOrcaStatus;

  beforeEach(async () => {
    const mod = await import("../src/linear/sync.js");
    mapLinearStateToOrcaStatus = mod.mapLinearStateToOrcaStatus;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Type-based mappings
  test("backlog type → backlog", () => {
    expect(mapLinearStateToOrcaStatus("Backlog", "backlog")).toBe("backlog");
    expect(mapLinearStateToOrcaStatus("Custom Backlog", "backlog")).toBe("backlog");
  });

  test("unstarted type → ready", () => {
    expect(mapLinearStateToOrcaStatus("Todo", "unstarted")).toBe("ready");
    expect(mapLinearStateToOrcaStatus("Ready", "unstarted")).toBe("ready");
  });

  test("started type without /review/ → running", () => {
    expect(mapLinearStateToOrcaStatus("In Progress", "started")).toBe("running");
    expect(mapLinearStateToOrcaStatus("Working", "started")).toBe("running");
  });

  test("started type with /review/ → in_review", () => {
    expect(mapLinearStateToOrcaStatus("In Review", "started")).toBe("in_review");
    expect(mapLinearStateToOrcaStatus("Code Review", "started")).toBe("in_review");
    expect(mapLinearStateToOrcaStatus("QA Review", "started")).toBe("in_review");
    expect(mapLinearStateToOrcaStatus("REVIEW", "started")).toBe("in_review");
  });

  test("completed type → done", () => {
    expect(mapLinearStateToOrcaStatus("Done", "completed")).toBe("done");
    expect(mapLinearStateToOrcaStatus("Finished", "completed")).toBe("done");
  });

  test("canceled type → null", () => {
    expect(mapLinearStateToOrcaStatus("Canceled", "canceled")).toBeNull();
    expect(mapLinearStateToOrcaStatus("Cancelled", "canceled")).toBeNull();
  });

  test("unknown type → null", () => {
    expect(mapLinearStateToOrcaStatus("Whatever", "triage")).toBeNull();
    expect(mapLinearStateToOrcaStatus("Unknown", "")).toBeNull();
  });

  // Override scenarios
  test("overrides take precedence over type-based mapping", () => {
    const overrides: Map<string, TaskStatus> = new Map([
      ["My Custom State", "in_review"],
    ]);
    // "My Custom State" has type "started" — would normally be "running"
    // but override wins
    expect(mapLinearStateToOrcaStatus("My Custom State", "started", overrides)).toBe("in_review");
  });

  test("override can map started/non-review to in_review", () => {
    const overrides: Map<string, TaskStatus> = new Map([
      ["Checking", "in_review"],
    ]);
    expect(mapLinearStateToOrcaStatus("Checking", "started", overrides)).toBe("in_review");
  });

  test("override can remap backlog type to different status", () => {
    const overrides: Map<string, TaskStatus> = new Map([
      ["Ice Box", "backlog"],
    ]);
    expect(mapLinearStateToOrcaStatus("Ice Box", "backlog", overrides)).toBe("backlog");
  });

  test("override key not present → falls through to type-based", () => {
    const overrides: Map<string, TaskStatus> = new Map([
      ["Other State", "done"],
    ]);
    // This state is NOT in overrides → type-based applies
    expect(mapLinearStateToOrcaStatus("In Progress", "started", overrides)).toBe("running");
  });

  test("empty overrides → type-based mapping", () => {
    const overrides: Map<string, TaskStatus> = new Map();
    expect(mapLinearStateToOrcaStatus("Todo", "unstarted", overrides)).toBe("ready");
  });
});

// ===========================================================================
// resolveConflict — type-based comparisons
// ===========================================================================

describe("EMI-204 — resolveConflict type-based", () => {
  let db: OrcaDb;
  let resolveConflict: typeof import("../src/linear/sync.js").resolveConflict;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mod = await import("../src/linear/sync.js");
    resolveConflict = mod.resolveConflict;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("canceled type → sets failed regardless of state name", () => {
    seedTask(db, "T-C1", "running");
    resolveConflict(db, "T-C1", "Cancelled", "canceled");
    expect(getTask(db, "T-C1")!.orcaStatus).toBe("failed");
  });

  test("canceled type with custom name → sets failed", () => {
    seedTask(db, "T-C2", "ready");
    resolveConflict(db, "T-C2", "Rejected", "canceled");
    expect(getTask(db, "T-C2")!.orcaStatus).toBe("failed");
  });

  test("backlog type → resets to backlog (custom name)", () => {
    seedTask(db, "T-B1", "running");
    resolveConflict(db, "T-B1", "Icebox", "backlog");
    expect(getTask(db, "T-B1")!.orcaStatus).toBe("backlog");
  });

  test("unstarted type → resets to ready (custom name)", () => {
    seedTask(db, "T-U1", "done");
    resolveConflict(db, "T-U1", "Ready to Go", "unstarted");
    expect(getTask(db, "T-U1")!.orcaStatus).toBe("ready");
  });

  test("completed type, ready task → done", () => {
    seedTask(db, "T-D1", "ready");
    resolveConflict(db, "T-D1", "Finished", "completed");
    expect(getTask(db, "T-D1")!.orcaStatus).toBe("done");
  });

  test("completed type, in_review → done (human override)", () => {
    seedTask(db, "T-D2", "in_review");
    resolveConflict(db, "T-D2", "Finished", "completed");
    expect(getTask(db, "T-D2")!.orcaStatus).toBe("done");
  });

  test("deploying + started/in_review → no-op", () => {
    seedTask(db, "T-D3", "deploying");
    resolveConflict(db, "T-D3", "In Review", "started");
    expect(getTask(db, "T-D3")!.orcaStatus).toBe("deploying");
  });

  test("awaiting_ci + started/in_review → no-op", () => {
    seedTask(db, "T-D4", "awaiting_ci");
    resolveConflict(db, "T-D4", "Code Review", "started");
    expect(getTask(db, "T-D4")!.orcaStatus).toBe("awaiting_ci");
  });

  test("deploying + completed → done", () => {
    seedTask(db, "T-D5", "deploying");
    resolveConflict(db, "T-D5", "Done", "completed");
    expect(getTask(db, "T-D5")!.orcaStatus).toBe("done");
  });

  test("awaiting_ci + completed → done", () => {
    seedTask(db, "T-D6", "awaiting_ci");
    resolveConflict(db, "T-D6", "Done", "completed");
    expect(getTask(db, "T-D6")!.orcaStatus).toBe("done");
  });

  test("no conflict when types match: started/running vs running → no change", () => {
    seedTask(db, "T-NC1", "running");
    resolveConflict(db, "T-NC1", "In Progress", "started");
    expect(getTask(db, "T-NC1")!.orcaStatus).toBe("running");
  });

  test("nonexistent task → no crash", () => {
    expect(() => resolveConflict(db, "MISSING", "Todo", "unstarted")).not.toThrow();
  });
});

// Unit tests for mapLinearStateToOrcaStatus and resolveConflict type-based logic

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import { insertTask, getTask } from "../src/db/queries.js";

vi.mock("../src/scheduler/index.js", () => ({ activeHandles: new Map() }));
vi.mock("../src/runner/index.js", () => ({ killSession: vi.fn() }));
vi.mock("../src/github/index.js", () => ({ closePrsForCanceledTask: vi.fn() }));

import { mapLinearStateToOrcaStatus, resolveConflict } from "../src/linear/sync.js";

function freshDb(): OrcaDb {
  return createDb(":memory:");
}

function now(): string {
  return new Date().toISOString();
}

function seedTask(db: OrcaDb, status: string, id = "TEST-1"): void {
  const ts = now();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: "do something",
    repoPath: "/tmp/fake-repo",
    orcaStatus: status as any,
    priority: 0,
    retryCount: 0,
    createdAt: ts,
    updatedAt: ts,
  });
}

describe("mapLinearStateToOrcaStatus", () => {
  it("backlog type → backlog", () => {
    expect(mapLinearStateToOrcaStatus("Backlog", "backlog")).toBe("backlog");
  });

  it("unstarted type → ready", () => {
    expect(mapLinearStateToOrcaStatus("Todo", "unstarted")).toBe("ready");
    expect(mapLinearStateToOrcaStatus("Triage", "unstarted")).toBe("ready");
  });

  it("started type → running (no review in name)", () => {
    expect(mapLinearStateToOrcaStatus("In Progress", "started")).toBe("running");
    expect(mapLinearStateToOrcaStatus("Development", "started")).toBe("running");
  });

  it("started type + review in name → in_review", () => {
    expect(mapLinearStateToOrcaStatus("In Review", "started")).toBe("in_review");
    expect(mapLinearStateToOrcaStatus("Code Review", "started")).toBe("in_review");
    expect(mapLinearStateToOrcaStatus("REVIEW", "started")).toBe("in_review");
  });

  it("completed type → done", () => {
    expect(mapLinearStateToOrcaStatus("Done", "completed")).toBe("done");
    expect(mapLinearStateToOrcaStatus("Shipped", "completed")).toBe("done");
  });

  it("canceled type → null", () => {
    expect(mapLinearStateToOrcaStatus("Canceled", "canceled")).toBeNull();
    expect(mapLinearStateToOrcaStatus("Duplicate", "canceled")).toBeNull();
  });

  it("unknown type → null", () => {
    expect(mapLinearStateToOrcaStatus("Whatever", "unknown_type")).toBeNull();
  });

  it("override takes precedence over type", () => {
    const overrides = { "Custom State": "in_review" };
    expect(mapLinearStateToOrcaStatus("Custom State", "unstarted", overrides)).toBe("in_review");
  });

  it("skip override returns null", () => {
    const overrides = { "Todo": "skip" };
    expect(mapLinearStateToOrcaStatus("Todo", "unstarted", overrides)).toBeNull();
  });

  it("override does not affect non-matching names", () => {
    const overrides = { "Custom State": "in_review" };
    expect(mapLinearStateToOrcaStatus("Todo", "unstarted", overrides)).toBe("ready");
  });
});

describe("resolveConflict type-based logic", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  it("canceled type kills session and marks failed", () => {
    seedTask(db, "running");
    resolveConflict(db, "TEST-1", "Canceled", "canceled");
    expect(getTask(db, "TEST-1")!.orcaStatus).toBe("failed");
  });

  it("backlog type resets to backlog with counter reset", () => {
    seedTask(db, "running");
    resolveConflict(db, "TEST-1", "Backlog", "backlog");
    const task = getTask(db, "TEST-1")!;
    expect(task.orcaStatus).toBe("backlog");
    expect(task.retryCount).toBe(0);
  });

  it("unstarted type resets to ready with counter reset", () => {
    seedTask(db, "done");
    resolveConflict(db, "TEST-1", "Todo", "unstarted");
    const task = getTask(db, "TEST-1")!;
    expect(task.orcaStatus).toBe("ready");
    expect(task.retryCount).toBe(0);
  });

  it("completed type marks done", () => {
    seedTask(db, "ready");
    resolveConflict(db, "TEST-1", "Done", "completed");
    expect(getTask(db, "TEST-1")!.orcaStatus).toBe("done");
  });

  it("deploying + started+review → no-op", () => {
    seedTask(db, "deploying");
    resolveConflict(db, "TEST-1", "In Review", "started");
    expect(getTask(db, "TEST-1")!.orcaStatus).toBe("deploying");
  });

  it("awaiting_ci + started+review → no-op", () => {
    seedTask(db, "awaiting_ci");
    resolveConflict(db, "TEST-1", "In Review", "started");
    expect(getTask(db, "TEST-1")!.orcaStatus).toBe("awaiting_ci");
  });

  it("missing task returns without error", () => {
    expect(() => resolveConflict(db, "NONEXISTENT", "Todo", "unstarted")).not.toThrow();
  });

  it("custom unstarted state name resets to ready via type", () => {
    seedTask(db, "done");
    resolveConflict(db, "TEST-1", "Triage", "unstarted");
    expect(getTask(db, "TEST-1")!.orcaStatus).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// DependencyGraph unit tests
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DependencyGraph } from "../src/linear/graph.js";
import type { LinearIssue } from "../src/linear/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(
  id: string,
  relations: { type: string; issueId: string; issueIdentifier: string }[] = [],
  inverseRelations: {
    type: string;
    issueId: string;
    issueIdentifier: string;
  }[] = [],
): LinearIssue {
  return {
    id,
    identifier: id,
    title: `Issue ${id}`,
    description: "",
    priority: 0,
    state: { id: "s1", name: "Todo", type: "unstarted" },
    teamId: "team-1",
    projectId: "proj-1",
    projectName: "Test Project",
    relations,
    inverseRelations,
    parentId: null,
    parentTitle: null,
    parentDescription: null,
    childIds: [],
    labels: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DependencyGraph", () => {
  let graph: DependencyGraph;

  beforeEach(() => {
    graph = new DependencyGraph();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Empty graph / unknown IDs
  // -------------------------------------------------------------------------

  it("isDispatchable returns true for unknown IDs (no blockers recorded)", () => {
    expect(graph.isDispatchable("unknown-id", () => "ready")).toBe(true);
  });

  it("rebuild with empty array does not crash", () => {
    expect(() => graph.rebuild([])).not.toThrow();
    expect(graph.isDispatchable("any", () => "ready")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Blocking via relations
  // -------------------------------------------------------------------------

  it("A blocks B via relations → B not dispatchable when A not done", () => {
    const issueA = makeIssue("A", [
      { type: "blocks", issueId: "B", issueIdentifier: "B" },
    ]);
    const issueB = makeIssue("B");

    graph.rebuild([issueA, issueB]);

    const getStatus = (id: string) => (id === "A" ? "running" : "ready");
    expect(graph.isDispatchable("B", getStatus)).toBe(false);
  });

  it("A blocks B via relations → A itself is dispatchable (no blockers on A)", () => {
    const issueA = makeIssue("A", [
      { type: "blocks", issueId: "B", issueIdentifier: "B" },
    ]);
    const issueB = makeIssue("B");

    graph.rebuild([issueA, issueB]);

    expect(graph.isDispatchable("A", () => "ready")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Blocking via inverseRelations
  // -------------------------------------------------------------------------

  it("A blocks B via B's inverseRelations → B not dispatchable when A running", () => {
    const issueA = makeIssue("A");
    // B has inverseRelation: A blocks B
    const issueB = makeIssue("B", [], [
      { type: "blocks", issueId: "A", issueIdentifier: "A" },
    ]);

    graph.rebuild([issueA, issueB]);

    const getStatus = (id: string) => (id === "A" ? "running" : "ready");
    expect(graph.isDispatchable("B", getStatus)).toBe(false);
  });

  it("A blocks B via B's inverseRelations → A is dispatchable", () => {
    const issueA = makeIssue("A");
    const issueB = makeIssue("B", [], [
      { type: "blocks", issueId: "A", issueIdentifier: "A" },
    ]);

    graph.rebuild([issueA, issueB]);

    expect(graph.isDispatchable("A", () => "ready")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // All blockers done
  // -------------------------------------------------------------------------

  it("isDispatchable returns true when all blockers are done", () => {
    const issueA = makeIssue("A", [
      { type: "blocks", issueId: "B", issueIdentifier: "B" },
    ]);
    const issueB = makeIssue("B");

    graph.rebuild([issueA, issueB]);

    // A is done → B can be dispatched
    expect(graph.isDispatchable("B", () => "done")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Multiple blockers
  // -------------------------------------------------------------------------

  it("multiple blockers: one not done → not dispatchable", () => {
    const issueA = makeIssue("A", [
      { type: "blocks", issueId: "C", issueIdentifier: "C" },
    ]);
    const issueB = makeIssue("B", [
      { type: "blocks", issueId: "C", issueIdentifier: "C" },
    ]);
    const issueC = makeIssue("C");

    graph.rebuild([issueA, issueB, issueC]);

    // A is done, B is not
    const getStatus = (id: string) => (id === "A" ? "done" : "ready");
    expect(graph.isDispatchable("C", getStatus)).toBe(false);
  });

  it("multiple blockers: all done → dispatchable", () => {
    const issueA = makeIssue("A", [
      { type: "blocks", issueId: "C", issueIdentifier: "C" },
    ]);
    const issueB = makeIssue("B", [
      { type: "blocks", issueId: "C", issueIdentifier: "C" },
    ]);
    const issueC = makeIssue("C");

    graph.rebuild([issueA, issueB, issueC]);

    expect(graph.isDispatchable("C", () => "done")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // rebuild clears previous state
  // -------------------------------------------------------------------------

  it("rebuild clears previous graph state", () => {
    // First build: A blocks B
    const issueA = makeIssue("A", [
      { type: "blocks", issueId: "B", issueIdentifier: "B" },
    ]);
    graph.rebuild([issueA, makeIssue("B")]);

    expect(
      graph.isDispatchable("B", (id) => (id === "A" ? "running" : "ready")),
    ).toBe(false);

    // Rebuild with no relations
    graph.rebuild([makeIssue("A"), makeIssue("B")]);

    // B should now be freely dispatchable
    expect(graph.isDispatchable("B", () => "ready")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // computeEffectivePriority — no blocks
  // -------------------------------------------------------------------------

  it("computeEffectivePriority returns own priority when no outgoing blocks", () => {
    graph.rebuild([makeIssue("A")]);

    const result = graph.computeEffectivePriority("A", () => 3);
    expect(result).toBe(3);
  });

  // -------------------------------------------------------------------------
  // computeEffectivePriority — chain inheritance
  // -------------------------------------------------------------------------

  it("A blocks B blocks C (urgent=1) → A's effective priority is 1", () => {
    const issueA = makeIssue("A", [
      { type: "blocks", issueId: "B", issueIdentifier: "B" },
    ]);
    const issueB = makeIssue("B", [
      { type: "blocks", issueId: "C", issueIdentifier: "C" },
    ]);
    const issueC = makeIssue("C");

    graph.rebuild([issueA, issueB, issueC]);

    const priorities: Record<string, number> = { A: 4, B: 3, C: 1 };
    const getPriority = (id: string) => priorities[id] ?? 0;

    expect(graph.computeEffectivePriority("A", getPriority)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // computeEffectivePriority — priority 0 treated as no-priority
  // -------------------------------------------------------------------------

  it("priority 0 on blocked issue does not override a real priority", () => {
    const issueA = makeIssue("A", [
      { type: "blocks", issueId: "B", issueIdentifier: "B" },
    ]);
    const issueB = makeIssue("B");

    graph.rebuild([issueA, issueB]);

    // A has priority 3, B has 0 (no priority) → A stays at 3
    const getPriority = (id: string) => (id === "A" ? 3 : 0);
    expect(graph.computeEffectivePriority("A", getPriority)).toBe(3);
  });

  it("all unprioritized (0) falls back to own priority", () => {
    const issueA = makeIssue("A", [
      { type: "blocks", issueId: "B", issueIdentifier: "B" },
    ]);
    graph.rebuild([issueA, makeIssue("B")]);

    // Both A and B have priority 0
    const result = graph.computeEffectivePriority("A", () => 0);
    expect(result).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Cycle detection
  // -------------------------------------------------------------------------

  it("cycle A→B→A does not infinite loop and logs warning", () => {
    const warnSpy = vi.spyOn(console, "warn");

    const issueA = makeIssue("A", [
      { type: "blocks", issueId: "B", issueIdentifier: "B" },
    ]);
    const issueB = makeIssue("B", [
      { type: "blocks", issueId: "A", issueIdentifier: "A" },
    ]);

    graph.rebuild([issueA, issueB]);

    const priorities: Record<string, number> = { A: 3, B: 2 };
    const getPriority = (id: string) => priorities[id] ?? 0;

    // Should not hang or throw
    const result = graph.computeEffectivePriority("A", getPriority);

    expect(typeof result).toBe("number");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("cycle detected"),
    );
  });

  it("isDispatchable with a cycle does not infinite loop", () => {
    const issueA = makeIssue("A", [
      { type: "blocks", issueId: "B", issueIdentifier: "B" },
    ]);
    const issueB = makeIssue("B", [
      { type: "blocks", issueId: "A", issueIdentifier: "A" },
    ]);

    graph.rebuild([issueA, issueB]);

    // isDispatchable only reads blockedBy, not blocks, so no recursion.
    // A is blocked by B, B is blocked by A → both not done → not dispatchable.
    expect(
      graph.isDispatchable("A", (id) => (id === "B" ? "running" : "ready")),
    ).toBe(false);
  });
});

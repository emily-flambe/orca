import { describe, it, expect, vi, beforeEach } from "vitest";
import { DependencyGraph } from "../src/linear/graph.js";
import type { LinearIssue } from "../src/linear/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(
  id: string,
  overrides: Partial<LinearIssue> = {},
): LinearIssue {
  return {
    id,
    identifier: id,
    title: `Issue ${id}`,
    description: "",
    priority: 0,
    state: { id: "state-1", name: "Todo", type: "unstarted" },
    teamId: "team-1",
    projectId: "proj-1",
    projectName: "Project",
    relations: [],
    inverseRelations: [],
    parentId: null,
    parentTitle: null,
    parentDescription: null,
    childIds: [],
    labels: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DependencyGraph", () => {
  let graph: DependencyGraph;

  beforeEach(() => {
    graph = new DependencyGraph();
  });

  // 1. Empty graph — isDispatchable returns true for any task
  it("isDispatchable returns true for unknown task on empty graph", () => {
    graph.rebuild([]);
    expect(graph.isDispatchable("task-x", () => undefined)).toBe(true);
  });

  // 2. rebuild with single blocking relation — blocked task is not dispatchable while blocker is non-done
  it("task blocked by a non-done blocker is not dispatchable", () => {
    const blocker = makeIssue("A", {
      relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
    });
    const blocked = makeIssue("B");

    graph.rebuild([blocker, blocked]);

    const getStatus = (id: string) => (id === "A" ? "running" : undefined);
    expect(graph.isDispatchable("B", getStatus)).toBe(false);
  });

  // 3. Blocker transitions to "done" — task becomes dispatchable
  it("task becomes dispatchable when all its blockers are done", () => {
    const blocker = makeIssue("A", {
      relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
    });
    const blocked = makeIssue("B");

    graph.rebuild([blocker, blocked]);

    const getStatus = (id: string) => (id === "A" ? "done" : "ready");
    expect(graph.isDispatchable("B", getStatus)).toBe(true);
  });

  // 4. rebuild with inverseRelation of type "blocks" — correctly marks the task as blocked
  it("inverseRelation of type blocks marks the issue as blocked by source", () => {
    // B has an inverseRelation saying A blocks it
    const blocked = makeIssue("B", {
      inverseRelations: [
        { type: "blocks", issueId: "A", issueIdentifier: "A" },
      ],
    });
    const blocker = makeIssue("A");

    graph.rebuild([blocker, blocked]);

    const getStatus = (id: string) => (id === "A" ? "running" : undefined);
    expect(graph.isDispatchable("B", getStatus)).toBe(false);
  });

  // 5. Non-"blocks" relation types are ignored
  it("non-blocks relation types do not create blocking edges", () => {
    const issue = makeIssue("A", {
      relations: [{ type: "duplicate", issueId: "B", issueIdentifier: "B" }],
    });
    const other = makeIssue("B");

    graph.rebuild([issue, other]);

    expect(graph.isDispatchable("B", () => undefined)).toBe(true);
  });

  // 6. computeEffectivePriority — task with no blocked tasks returns its own priority
  it("computeEffectivePriority returns own priority when task blocks nothing", () => {
    const issue = makeIssue("A", { priority: 2 });
    graph.rebuild([issue]);

    expect(graph.computeEffectivePriority("A", () => 2)).toBe(2);
  });

  // 7. computeEffectivePriority — task blocking a high-priority task inherits that priority
  it("computeEffectivePriority returns minimum priority of self and blocked tasks", () => {
    const blocker = makeIssue("A", {
      priority: 3,
      relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
    });
    const blocked = makeIssue("B", { priority: 1 }); // higher priority (lower number)

    graph.rebuild([blocker, blocked]);

    const getPriority = (id: string) => (id === "A" ? 3 : 1);
    // A blocks B. B has priority 1 (urgent). A should inherit priority 1.
    expect(graph.computeEffectivePriority("A", getPriority)).toBe(1);
  });

  // 8. computeEffectivePriority — transitive: A blocks B blocks C, A gets C's priority
  it("computeEffectivePriority propagates transitively through blocking chain", () => {
    const a = makeIssue("A", {
      priority: 4,
      relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
    });
    const b = makeIssue("B", {
      priority: 3,
      relations: [{ type: "blocks", issueId: "C", issueIdentifier: "C" }],
    });
    const c = makeIssue("C", { priority: 1 });

    graph.rebuild([a, b, c]);

    const priorities: Record<string, number> = { A: 4, B: 3, C: 1 };
    const getPriority = (id: string) => priorities[id] ?? 0;

    // A → B → C. C has priority 1. A should inherit 1.
    expect(graph.computeEffectivePriority("A", getPriority)).toBe(1);
  });

  // 9. computeEffectivePriority — priority 0 (none) treated as unset (Infinity), doesn't win
  it("priority 0 is treated as unset and does not affect minimum", () => {
    const blocker = makeIssue("A", {
      priority: 2,
      relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
    });
    const blocked = makeIssue("B", { priority: 0 }); // no priority

    graph.rebuild([blocker, blocked]);

    const getPriority = (id: string) => (id === "A" ? 2 : 0);
    // B has priority 0 (unset). A's effective priority should remain 2, not 0.
    expect(graph.computeEffectivePriority("A", getPriority)).toBe(2);
  });

  // 10. Cycle detection — logged warning, no infinite loop, still returns a value
  it("handles cycles without infinite loops and logs a warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const a = makeIssue("A", {
      priority: 2,
      relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
    });
    const b = makeIssue("B", {
      priority: 3,
      relations: [{ type: "blocks", issueId: "A", issueIdentifier: "A" }],
    });

    graph.rebuild([a, b]);

    const getPriority = (id: string) => (id === "A" ? 2 : 3);

    // Should not throw and should return a number
    const result = graph.computeEffectivePriority("A", getPriority);
    expect(typeof result).toBe("number");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("cycle"));

    warnSpy.mockRestore();
  });

  // 11. rebuild called twice resets state (old edges removed)
  it("calling rebuild twice clears previous edges", () => {
    // First rebuild: A blocks B
    const firstA = makeIssue("A", {
      relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
    });
    const firstB = makeIssue("B");
    graph.rebuild([firstA, firstB]);

    // Confirm B is blocked
    expect(graph.isDispatchable("B", () => "ready")).toBe(false);

    // Second rebuild: no blocking relations
    const newA = makeIssue("A");
    const newB = makeIssue("B");
    graph.rebuild([newA, newB]);

    // B should now be dispatchable (old edge cleared)
    expect(graph.isDispatchable("B", () => "ready")).toBe(true);
  });
});

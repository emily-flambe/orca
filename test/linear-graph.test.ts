import { describe, it, expect, vi, afterEach } from "vitest";
import { DependencyGraph } from "../src/linear/graph.js";
import type { LinearIssue } from "../src/linear/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal LinearIssue with only the fields DependencyGraph.rebuild cares about. */
function makeIssue(
  id: string,
  overrides: Partial<LinearIssue> = {},
): LinearIssue {
  return {
    id,
    identifier: id,
    title: "Test Issue",
    description: "",
    priority: 0,
    state: { id: "state-1", name: "Todo", type: "unstarted" },
    teamId: "team-1",
    projectId: "proj-1",
    projectName: "Test Project",
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Empty graph — any ID is dispatchable
  it("isDispatchable returns true for any id when graph is empty", () => {
    const graph = new DependencyGraph();
    expect(graph.isDispatchable("any-id", () => undefined)).toBe(true);
  });

  // 2. Task with no relations is dispatchable
  it("task with no relations is dispatchable", () => {
    const graph = new DependencyGraph();
    graph.rebuild([makeIssue("task-a")]);
    expect(graph.isDispatchable("task-a", () => undefined)).toBe(true);
  });

  // 3. Single blocker not done → not dispatchable
  it("task blocked by a non-done task is not dispatchable", () => {
    const graph = new DependencyGraph();
    graph.rebuild([
      makeIssue("blocker", {
        relations: [
          { type: "blocks", issueId: "task-a", issueIdentifier: "TASK-A" },
        ],
        inverseRelations: [],
      }),
      makeIssue("task-a"),
    ]);

    expect(
      graph.isDispatchable("task-a", (id) =>
        id === "blocker" ? "running" : undefined,
      ),
    ).toBe(false);
  });

  // 4. Single blocker done → dispatchable
  it("task blocked by a done task is dispatchable", () => {
    const graph = new DependencyGraph();
    graph.rebuild([
      makeIssue("blocker", {
        relations: [
          { type: "blocks", issueId: "task-a", issueIdentifier: "TASK-A" },
        ],
        inverseRelations: [],
      }),
      makeIssue("task-a"),
    ]);

    expect(
      graph.isDispatchable("task-a", (id) =>
        id === "blocker" ? "done" : undefined,
      ),
    ).toBe(true);
  });

  // 5. Multiple blockers, one not done → not dispatchable
  it("task with multiple blockers where one is not done is not dispatchable", () => {
    const graph = new DependencyGraph();
    graph.rebuild([
      makeIssue("b1", {
        relations: [
          { type: "blocks", issueId: "task-a", issueIdentifier: "TASK-A" },
        ],
        inverseRelations: [],
      }),
      makeIssue("b2", {
        relations: [
          { type: "blocks", issueId: "task-a", issueIdentifier: "TASK-A" },
        ],
        inverseRelations: [],
      }),
      makeIssue("task-a"),
    ]);

    expect(
      graph.isDispatchable("task-a", (id) => {
        if (id === "b1") return "done";
        if (id === "b2") return "ready";
        return undefined;
      }),
    ).toBe(false);
  });

  // 6. Multiple blockers, all done → dispatchable
  it("task with multiple blockers all done is dispatchable", () => {
    const graph = new DependencyGraph();
    graph.rebuild([
      makeIssue("b1", {
        relations: [
          { type: "blocks", issueId: "task-a", issueIdentifier: "TASK-A" },
        ],
        inverseRelations: [],
      }),
      makeIssue("b2", {
        relations: [
          { type: "blocks", issueId: "task-a", issueIdentifier: "TASK-A" },
        ],
        inverseRelations: [],
      }),
      makeIssue("task-a"),
    ]);

    expect(
      graph.isDispatchable("task-a", (id) => {
        if (id === "b1" || id === "b2") return "done";
        return undefined;
      }),
    ).toBe(true);
  });

  // 7. Relation type != "blocks" does not create blocking edge
  it("non-blocks relation types do not create blocking edges", () => {
    const graph = new DependencyGraph();
    graph.rebuild([
      makeIssue("task-b", {
        relations: [
          { type: "relates", issueId: "task-a", issueIdentifier: "TASK-A" },
        ],
        inverseRelations: [],
      }),
      makeIssue("task-a"),
    ]);

    // task-a should be dispatchable because "relates" is not a block
    expect(
      graph.isDispatchable("task-a", (id) =>
        id === "task-b" ? "running" : undefined,
      ),
    ).toBe(true);
  });

  // 8. inverseRelations with type "blocks" creates blocking from source issue
  it("inverseRelation with type blocks correctly marks the issue as blocked", () => {
    const graph = new DependencyGraph();
    // task-a has an inverseRelation saying blocker blocks task-a
    graph.rebuild([
      makeIssue("task-a", {
        relations: [],
        inverseRelations: [
          { type: "blocks", issueId: "blocker", issueIdentifier: "BLOCKER" },
        ],
      }),
      makeIssue("blocker"),
    ]);

    expect(
      graph.isDispatchable("task-a", (id) =>
        id === "blocker" ? "running" : undefined,
      ),
    ).toBe(false);

    expect(
      graph.isDispatchable("task-a", (id) =>
        id === "blocker" ? "done" : undefined,
      ),
    ).toBe(true);
  });

  // 9. computeEffectivePriority — no dependencies returns own priority
  it("computeEffectivePriority returns own priority when task has no dependencies", () => {
    const graph = new DependencyGraph();
    graph.rebuild([makeIssue("task-a", { priority: 2 })]);

    expect(
      graph.computeEffectivePriority("task-a", (id) =>
        id === "task-a" ? 2 : 0,
      ),
    ).toBe(2);
  });

  // 10. computeEffectivePriority — task blocking a high-priority task inherits its priority
  it("computeEffectivePriority inherits higher priority from blocked downstream task", () => {
    const graph = new DependencyGraph();
    // blocker (priority 3) blocks downstream (priority 1 = urgent)
    graph.rebuild([
      makeIssue("blocker", {
        priority: 3,
        relations: [
          { type: "blocks", issueId: "downstream", issueIdentifier: "DOWN" },
        ],
        inverseRelations: [],
      }),
      makeIssue("downstream", { priority: 1 }),
    ]);

    const getPriority = (id: string) => {
      if (id === "blocker") return 3;
      if (id === "downstream") return 1;
      return 0;
    };

    // blocker's effective priority should be 1 (min of 3 and downstream's 1)
    expect(graph.computeEffectivePriority("blocker", getPriority)).toBe(1);
  });

  // 11. Priority 0 treated as Infinity — does not promote effective priority
  it("priority 0 is treated as Infinity and does not win the min comparison", () => {
    const graph = new DependencyGraph();
    // blocker (priority 2) blocks downstream (priority 0 = no priority)
    graph.rebuild([
      makeIssue("blocker", {
        priority: 2,
        relations: [
          { type: "blocks", issueId: "downstream", issueIdentifier: "DOWN" },
        ],
        inverseRelations: [],
      }),
      makeIssue("downstream", { priority: 0 }),
    ]);

    const getPriority = (id: string) => {
      if (id === "blocker") return 2;
      if (id === "downstream") return 0;
      return 0;
    };

    // downstream has no priority (0 = Infinity), so blocker's effective stays at 2
    expect(graph.computeEffectivePriority("blocker", getPriority)).toBe(2);
  });

  // 12. Cycle detection — logs warning and doesn't infinite-loop
  it("cycle detection logs a warning and terminates without hanging", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn");

    const graph = new DependencyGraph();
    // a blocks b, b blocks a — a cycle
    graph.rebuild([
      makeIssue("a", {
        relations: [{ type: "blocks", issueId: "b", issueIdentifier: "B" }],
        inverseRelations: [],
      }),
      makeIssue("b", {
        relations: [{ type: "blocks", issueId: "a", issueIdentifier: "A" }],
        inverseRelations: [],
      }),
    ]);

    // Should not throw or hang
    expect(() => graph.computeEffectivePriority("a", () => 2)).not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("cycle detected"),
    );
  });

  // 13. rebuild clears old graph data
  it("rebuild with different data replaces the previous graph", () => {
    const graph = new DependencyGraph();

    // First build: blocker blocks task-a
    graph.rebuild([
      makeIssue("blocker", {
        relations: [
          { type: "blocks", issueId: "task-a", issueIdentifier: "TASK-A" },
        ],
        inverseRelations: [],
      }),
      makeIssue("task-a"),
    ]);

    // task-a is blocked
    expect(
      graph.isDispatchable("task-a", (id) =>
        id === "blocker" ? "running" : undefined,
      ),
    ).toBe(false);

    // Second build: no blocking relations
    graph.rebuild([makeIssue("blocker"), makeIssue("task-a")]);

    // task-a is now free
    expect(
      graph.isDispatchable("task-a", (id) =>
        id === "blocker" ? "running" : undefined,
      ),
    ).toBe(true);
  });
});

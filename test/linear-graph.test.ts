// ---------------------------------------------------------------------------
// DependencyGraph tests
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DependencyGraph } from "../src/linear/graph.js";
import type { LinearIssue } from "../src/linear/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(id: string, overrides?: Partial<LinearIssue>): LinearIssue {
  return {
    id,
    identifier: id,
    title: `Issue ${id}`,
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
  let graph: DependencyGraph;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    graph = new DependencyGraph();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // isDispatchable
  // -------------------------------------------------------------------------

  describe("isDispatchable", () => {
    // 1. Empty graph — task with no blockers → true
    it("task not in graph (no blockers) is dispatchable", () => {
      graph.rebuild([makeIssue("A")]);
      expect(graph.isDispatchable("A", () => "ready")).toBe(true);
    });

    // 2. Task blocked by one issue that is "done" → true
    it("task blocked by one done issue is dispatchable", () => {
      const A = makeIssue("A", {
        relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
      });
      const B = makeIssue("B");
      graph.rebuild([A, B]);

      const statuses: Record<string, string> = { A: "done", B: "ready" };
      expect(graph.isDispatchable("B", (id) => statuses[id])).toBe(true);
    });

    // 3. Task blocked by one issue that is "running" → false
    it("task blocked by one running issue is not dispatchable", () => {
      const A = makeIssue("A", {
        relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
      });
      const B = makeIssue("B");
      graph.rebuild([A, B]);

      const statuses: Record<string, string> = { A: "running", B: "ready" };
      expect(graph.isDispatchable("B", (id) => statuses[id])).toBe(false);
    });

    // 4. Task blocked by two issues — one "done", one "running" → false
    it("task blocked by two issues where one is not done is not dispatchable", () => {
      const A = makeIssue("A", {
        relations: [
          { type: "blocks", issueId: "C", issueIdentifier: "C" },
        ],
      });
      const B = makeIssue("B", {
        relations: [{ type: "blocks", issueId: "C", issueIdentifier: "C" }],
      });
      const C = makeIssue("C");
      graph.rebuild([A, B, C]);

      const statuses: Record<string, string> = {
        A: "done",
        B: "running",
        C: "ready",
      };
      expect(graph.isDispatchable("C", (id) => statuses[id])).toBe(false);
    });

    // 5. Task blocked by two issues — both "done" → true
    it("task blocked by two issues both done is dispatchable", () => {
      const A = makeIssue("A", {
        relations: [{ type: "blocks", issueId: "C", issueIdentifier: "C" }],
      });
      const B = makeIssue("B", {
        relations: [{ type: "blocks", issueId: "C", issueIdentifier: "C" }],
      });
      const C = makeIssue("C");
      graph.rebuild([A, B, C]);

      const statuses: Record<string, string> = {
        A: "done",
        B: "done",
        C: "ready",
      };
      expect(graph.isDispatchable("C", (id) => statuses[id])).toBe(true);
    });

    // 6. A blocks B — A's own dispatchability is unaffected by the edge
    it("the blocker (A) is dispatchable regardless of blocking B", () => {
      const A = makeIssue("A", {
        relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
      });
      const B = makeIssue("B");
      graph.rebuild([A, B]);

      // A is not blocked by anyone
      expect(graph.isDispatchable("A", () => "ready")).toBe(true);
    });

    // 7. Rebuild with new issues clears old graph state
    it("rebuild clears old graph state", () => {
      const A = makeIssue("A", {
        relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
      });
      const B = makeIssue("B");
      graph.rebuild([A, B]);

      // B is blocked by A (running) — not dispatchable
      expect(graph.isDispatchable("B", () => "running")).toBe(false);

      // Rebuild with fresh issues that have no relations
      graph.rebuild([makeIssue("A"), makeIssue("B")]);

      // B is now free
      expect(graph.isDispatchable("B", () => "running")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // computeEffectivePriority
  // -------------------------------------------------------------------------

  describe("computeEffectivePriority", () => {
    // 8. Task with no downstream: returns own priority
    it("task with no downstream returns its own priority", () => {
      graph.rebuild([makeIssue("A", { priority: 2 })]);
      expect(graph.computeEffectivePriority("A", () => 2)).toBe(2);
    });

    // 9. Priority 0 treated as "no priority" (Infinity), falls back to own raw priority
    it("priority 0 is treated as no-priority and falls back to own raw value", () => {
      graph.rebuild([makeIssue("A", { priority: 0 })]);
      expect(graph.computeEffectivePriority("A", () => 0)).toBe(0);
    });

    // 10. Task blocks higher-priority (lower number) issue: effective = blocked issue's priority
    it("task that blocks a higher-priority issue inherits that priority", () => {
      const A = makeIssue("A", {
        priority: 3,
        relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
      });
      const B = makeIssue("B", { priority: 1 });
      graph.rebuild([A, B]);

      const priorities: Record<string, number> = { A: 3, B: 1 };
      expect(graph.computeEffectivePriority("A", (id) => priorities[id])).toBe(
        1,
      );
    });

    // 11. Transitive chain: A blocks B blocks C, C has priority 1, A has priority 0 → A's effective = 1
    it("transitive chain: A(0) blocks B(0) blocks C(1) → A effective priority = 1", () => {
      const A = makeIssue("A", {
        priority: 0,
        relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
      });
      const B = makeIssue("B", {
        priority: 0,
        relations: [{ type: "blocks", issueId: "C", issueIdentifier: "C" }],
      });
      const C = makeIssue("C", { priority: 1 });
      graph.rebuild([A, B, C]);

      const priorities: Record<string, number> = { A: 0, B: 0, C: 1 };
      expect(graph.computeEffectivePriority("A", (id) => priorities[id])).toBe(
        1,
      );
    });

    // 12. Cycle detection: A blocks B blocks A → doesn't infinite-loop, warns
    it("cycle in dependency graph does not infinite-loop and warns", () => {
      const A = makeIssue("A", {
        priority: 2,
        relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
      });
      const B = makeIssue("B", {
        priority: 2,
        relations: [{ type: "blocks", issueId: "A", issueIdentifier: "A" }],
      });
      graph.rebuild([A, B]);

      const priorities: Record<string, number> = { A: 2, B: 2 };
      // Should complete without throwing
      expect(() =>
        graph.computeEffectivePriority("A", (id) => priorities[id]),
      ).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("cycle"));
    });

    // 13. Task blocks multiple issues: takes minimum (highest urgency)
    it("task blocking multiple issues takes the minimum priority", () => {
      const A = makeIssue("A", {
        priority: 3,
        relations: [
          { type: "blocks", issueId: "B", issueIdentifier: "B" },
          { type: "blocks", issueId: "C", issueIdentifier: "C" },
        ],
      });
      const B = makeIssue("B", { priority: 2 });
      const C = makeIssue("C", { priority: 1 });
      graph.rebuild([A, B, C]);

      const priorities: Record<string, number> = { A: 3, B: 2, C: 1 };
      expect(graph.computeEffectivePriority("A", (id) => priorities[id])).toBe(
        1,
      );
    });
  });

  // -------------------------------------------------------------------------
  // rebuild edge cases
  // -------------------------------------------------------------------------

  describe("rebuild", () => {
    // 14. inverseRelations with type "blocks" treated correctly
    it("inverseRelations blocks: B.inverseRelation from A means A blocks B", () => {
      // B has an inverseRelation of type "blocks" from A, meaning A blocks B
      const A = makeIssue("A");
      const B = makeIssue("B", {
        inverseRelations: [
          { type: "blocks", issueId: "A", issueIdentifier: "A" },
        ],
      });
      graph.rebuild([A, B]);

      // B is blocked by A — if A is running, B should not be dispatchable
      expect(graph.isDispatchable("B", () => "running")).toBe(false);
      // A itself has no blockers
      expect(graph.isDispatchable("A", () => "running")).toBe(true);
    });

    // 15. relations with type other than "blocks" are ignored
    it("relations with type other than blocks are ignored", () => {
      const A = makeIssue("A", {
        relations: [
          { type: "duplicate", issueId: "B", issueIdentifier: "B" },
          { type: "related", issueId: "C", issueIdentifier: "C" },
        ],
      });
      const B = makeIssue("B");
      const C = makeIssue("C");
      graph.rebuild([A, B, C]);

      // Neither B nor C should be blocked by A
      expect(graph.isDispatchable("B", () => "running")).toBe(true);
      expect(graph.isDispatchable("C", () => "running")).toBe(true);
    });

    // 16. Empty issues array → all queries return no blockers
    it("empty issues array: all tasks have no blockers", () => {
      graph.rebuild([]);
      expect(graph.isDispatchable("any-id", () => "running")).toBe(true);
    });
  });
});

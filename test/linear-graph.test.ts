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
    title: "",
    description: "",
    priority: 0,
    state: { id: "s1", name: "Todo", type: "started" },
    teamId: "t1",
    projectId: "p1",
    projectName: "P",
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // rebuild — empty
  // -------------------------------------------------------------------------

  describe("rebuild with empty list", () => {
    it("produces an empty graph that considers any ID dispatchable", () => {
      graph.rebuild([]);
      expect(graph.isDispatchable("nonexistent", () => "todo")).toBe(true);
    });

    it("produces an empty graph that returns own priority for any ID", () => {
      graph.rebuild([]);
      const priority = graph.computeEffectivePriority("nonexistent", () => 2);
      expect(priority).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // rebuild — relations
  // -------------------------------------------------------------------------

  describe("rebuild from relations", () => {
    it("builds blocking edges from relations with type 'blocks'", () => {
      const issueA = makeIssue("A", {
        relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
      });
      const issueB = makeIssue("B");

      graph.rebuild([issueA, issueB]);

      // B is blocked by A
      expect(
        graph.isDispatchable("B", (id) => (id === "A" ? "running" : "todo")),
      ).toBe(false);
    });

    it("ignores relations with type other than 'blocks'", () => {
      const issueA = makeIssue("A", {
        relations: [{ type: "related", issueId: "B", issueIdentifier: "B" }],
      });
      const issueB = makeIssue("B");

      graph.rebuild([issueA, issueB]);

      // B should not be blocked
      expect(graph.isDispatchable("B", () => "todo")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // rebuild — inverseRelations
  // -------------------------------------------------------------------------

  describe("rebuild from inverseRelations", () => {
    it("builds blocking edges from inverseRelations with type 'blocks'", () => {
      // issueB has inverseRelation: A blocks B (A is the source blocking B)
      const issueA = makeIssue("A");
      const issueB = makeIssue("B", {
        inverseRelations: [
          { type: "blocks", issueId: "A", issueIdentifier: "A" },
        ],
      });

      graph.rebuild([issueA, issueB]);

      // B is blocked by A
      expect(
        graph.isDispatchable("B", (id) => (id === "A" ? "running" : "todo")),
      ).toBe(false);
    });

    it("ignores inverseRelations with type other than 'blocks'", () => {
      const issueA = makeIssue("A");
      const issueB = makeIssue("B", {
        inverseRelations: [
          { type: "related", issueId: "A", issueIdentifier: "A" },
        ],
      });

      graph.rebuild([issueA, issueB]);

      expect(graph.isDispatchable("B", () => "todo")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // isDispatchable
  // -------------------------------------------------------------------------

  describe("isDispatchable", () => {
    it("returns true when issue has no blockers", () => {
      graph.rebuild([makeIssue("A")]);
      expect(graph.isDispatchable("A", () => "todo")).toBe(true);
    });

    it("returns true when all blockers have status 'done'", () => {
      const issueA = makeIssue("A", {
        relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
      });
      const issueB = makeIssue("B");
      graph.rebuild([issueA, issueB]);

      expect(
        graph.isDispatchable("B", (id) => (id === "A" ? "done" : "todo")),
      ).toBe(true);
    });

    it("returns false when a blocker has status 'running'", () => {
      const issueA = makeIssue("A", {
        relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
      });
      const issueB = makeIssue("B");
      graph.rebuild([issueA, issueB]);

      expect(
        graph.isDispatchable("B", (id) => (id === "A" ? "running" : "todo")),
      ).toBe(false);
    });

    it("returns false when a blocker has status 'ready'", () => {
      const issueA = makeIssue("A", {
        relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
      });
      const issueB = makeIssue("B");
      graph.rebuild([issueA, issueB]);

      expect(
        graph.isDispatchable("B", (id) => (id === "A" ? "ready" : "done")),
      ).toBe(false);
    });

    it("returns true when all multiple blockers are done", () => {
      const issueA = makeIssue("A", {
        relations: [{ type: "blocks", issueId: "C", issueIdentifier: "C" }],
      });
      const issueB = makeIssue("B", {
        relations: [{ type: "blocks", issueId: "C", issueIdentifier: "C" }],
      });
      const issueC = makeIssue("C");
      graph.rebuild([issueA, issueB, issueC]);

      expect(
        graph.isDispatchable("C", (id) =>
          id === "A" || id === "B" ? "done" : "todo",
        ),
      ).toBe(true);
    });

    it("returns false when one of multiple blockers is not done", () => {
      const issueA = makeIssue("A", {
        relations: [{ type: "blocks", issueId: "C", issueIdentifier: "C" }],
      });
      const issueB = makeIssue("B", {
        relations: [{ type: "blocks", issueId: "C", issueIdentifier: "C" }],
      });
      const issueC = makeIssue("C");
      graph.rebuild([issueA, issueB, issueC]);

      expect(
        graph.isDispatchable("C", (id) => {
          if (id === "A") return "done";
          if (id === "B") return "running"; // B is not done
          return "todo";
        }),
      ).toBe(false);
    });

    it("returns true for unknown IDs (no blockers registered)", () => {
      graph.rebuild([makeIssue("A")]);
      expect(graph.isDispatchable("unknown-id", () => "done")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // computeEffectivePriority
  // -------------------------------------------------------------------------

  describe("computeEffectivePriority", () => {
    it("returns own priority when no blocked tasks exist", () => {
      graph.rebuild([makeIssue("A", { priority: 3 })]);
      const priority = graph.computeEffectivePriority("A", (id) => {
        if (id === "A") return 3;
        return 0;
      });
      expect(priority).toBe(3);
    });

    it("returns blocked task's priority when it is higher (lower number) than own", () => {
      // A blocks B; B has priority 1 (urgent), A has priority 3 (medium)
      const issueA = makeIssue("A", {
        priority: 3,
        relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
      });
      const issueB = makeIssue("B", { priority: 1 });
      graph.rebuild([issueA, issueB]);

      const priority = graph.computeEffectivePriority("A", (id) => {
        if (id === "A") return 3;
        if (id === "B") return 1;
        return 0;
      });
      expect(priority).toBe(1);
    });

    it("returns own priority when it is higher (lower number) than blocked task's", () => {
      // A blocks B; A has priority 1 (urgent), B has priority 3 (medium)
      const issueA = makeIssue("A", {
        priority: 1,
        relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
      });
      const issueB = makeIssue("B", { priority: 3 });
      graph.rebuild([issueA, issueB]);

      const priority = graph.computeEffectivePriority("A", (id) => {
        if (id === "A") return 1;
        if (id === "B") return 3;
        return 0;
      });
      expect(priority).toBe(1);
    });

    it("treats priority 0 as Infinity (never wins min comparison)", () => {
      // A has priority 0 (no priority) and B has priority 2
      const issueA = makeIssue("A", {
        priority: 0,
        relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
      });
      const issueB = makeIssue("B", { priority: 2 });
      graph.rebuild([issueA, issueB]);

      const priority = graph.computeEffectivePriority("A", (id) => {
        if (id === "A") return 0;
        if (id === "B") return 2;
        return 0;
      });
      // B has priority 2, which beats A's 0 (Infinity)
      expect(priority).toBe(2);
    });

    it("own priority 0 blocking a priority-1 task returns 1", () => {
      const issueA = makeIssue("A", {
        priority: 0,
        relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
      });
      const issueB = makeIssue("B", { priority: 1 });
      graph.rebuild([issueA, issueB]);

      const priority = graph.computeEffectivePriority("A", (id) => {
        if (id === "A") return 0;
        if (id === "B") return 1;
        return 0;
      });
      expect(priority).toBe(1);
    });

    it("returns own raw priority 0 when all tasks in chain have priority 0", () => {
      // A blocks B; both have priority 0
      const issueA = makeIssue("A", {
        priority: 0,
        relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
      });
      const issueB = makeIssue("B", { priority: 0 });
      graph.rebuild([issueA, issueB]);

      const priority = graph.computeEffectivePriority("A", () => 0);
      // Falls back to raw priority (0) since Infinity is the only result
      expect(priority).toBe(0);
    });

    it("handles transitive blocking — returns highest priority in chain", () => {
      // A blocks B, B blocks C. C has priority 1, B has priority 3, A has priority 4
      const issueA = makeIssue("A", {
        priority: 4,
        relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
      });
      const issueB = makeIssue("B", {
        priority: 3,
        relations: [{ type: "blocks", issueId: "C", issueIdentifier: "C" }],
      });
      const issueC = makeIssue("C", { priority: 1 });
      graph.rebuild([issueA, issueB, issueC]);

      const getPriority = (id: string) => {
        if (id === "A") return 4;
        if (id === "B") return 3;
        if (id === "C") return 1;
        return 0;
      };

      expect(graph.computeEffectivePriority("A", getPriority)).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Cycle detection
  // -------------------------------------------------------------------------

  describe("cycle detection", () => {
    it("warns on cycle and does not infinite loop", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // A blocks B, B blocks A — cycle
      const issueA = makeIssue("A", {
        priority: 2,
        relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
      });
      const issueB = makeIssue("B", {
        priority: 2,
        relations: [{ type: "blocks", issueId: "A", issueIdentifier: "A" }],
      });
      graph.rebuild([issueA, issueB]);

      // Should not throw or loop infinitely
      expect(() => graph.computeEffectivePriority("A", () => 2)).not.toThrow();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("cycle detected"),
      );
    });
  });

  // -------------------------------------------------------------------------
  // rebuild clears old graph
  // -------------------------------------------------------------------------

  describe("rebuild clears previous state", () => {
    it("removes old edges when rebuilt with a new issue list", () => {
      // First build: A blocks B
      const issueA = makeIssue("A", {
        relations: [{ type: "blocks", issueId: "B", issueIdentifier: "B" }],
      });
      const issueB = makeIssue("B");
      graph.rebuild([issueA, issueB]);

      // Confirm B is not dispatchable
      expect(graph.isDispatchable("B", () => "ready")).toBe(false);

      // Rebuild with no relations
      graph.rebuild([makeIssue("A"), makeIssue("B")]);

      // Now B should be dispatchable
      expect(graph.isDispatchable("B", () => "ready")).toBe(true);
    });
  });
});

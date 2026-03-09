// ---------------------------------------------------------------------------
// Adversarial tests for findStateByType, writeBackStatus, logStartupStateMapping
// ---------------------------------------------------------------------------

import {
  describe,
  test,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  findStateByType,
  logStartupStateMapping,
  writeBackStatus,
  expectedChanges,
  registerExpectedChange,
} from "../src/linear/sync.js";
import type { WorkflowStateMap } from "../src/linear/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMap(
  entries: Array<{ name: string; id: string; type: string }>,
): WorkflowStateMap {
  const m: WorkflowStateMap = new Map();
  for (const e of entries) {
    m.set(e.name, { id: e.id, type: e.type });
  }
  return m;
}

function makeMockClient() {
  return {
    updateIssueState: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// findStateByType — tier 1: override
// ---------------------------------------------------------------------------

describe("findStateByType – tier 1 override", () => {
  test("returns override state when it exists in stateMap", () => {
    const map = makeMap([
      { name: "Custom Done", id: "id-custom", type: "completed" },
      { name: "Done", id: "id-done", type: "completed" },
    ]);
    const result = findStateByType(map, "completed", false, "Custom Done");
    expect(result).toEqual({ id: "id-custom", name: "Custom Done" });
  });

  test("falls through to tier 2 when override name is not in stateMap", () => {
    const map = makeMap([
      { name: "Done", id: "id-done", type: "completed" },
    ]);
    // "Ghost State" does not exist — should fall through to tier 2 ("Done")
    const result = findStateByType(map, "completed", false, "Ghost State");
    expect(result).toEqual({ id: "id-done", name: "Done" });
  });

  test("falls through to tier 3 when override AND tier-2 name are absent", () => {
    const map = makeMap([
      { name: "Finished", id: "id-finished", type: "completed" },
    ]);
    const result = findStateByType(map, "completed", false, "Ghost State");
    expect(result).toEqual({ id: "id-finished", name: "Finished" });
  });
});

// ---------------------------------------------------------------------------
// findStateByType — tier 2: type validation
// ---------------------------------------------------------------------------

describe("findStateByType – tier 2 type validation", () => {
  test("skips conventional name 'Done' when its type is 'started' (corrupted data)", () => {
    // "Done" is in stateMap but has type "started" — tier 2 must skip it
    const map = makeMap([
      { name: "Done", id: "id-corrupted", type: "started" },
      { name: "Completed", id: "id-completed", type: "completed" },
    ]);
    const result = findStateByType(map, "completed", false);
    // Should NOT return the corrupted "Done" entry; should fall to tier 3 "Completed"
    expect(result).toEqual({ id: "id-completed", name: "Completed" });
  });

  test("skips conventional name 'Canceled' when its type is 'completed' (corrupted data)", () => {
    const map = makeMap([
      { name: "Canceled", id: "id-corrupted", type: "completed" },
      { name: "Won't Fix", id: "id-canceled", type: "canceled" },
    ]);
    const result = findStateByType(map, "canceled", false);
    expect(result).toEqual({ id: "id-canceled", name: "Won't Fix" });
  });

  test("skips conventional 'In Progress' when its type is not started", () => {
    const map = makeMap([
      { name: "In Progress", id: "id-corrupted", type: "unstarted" },
      { name: "Working", id: "id-working", type: "started" },
    ]);
    const result = findStateByType(map, "started", false);
    // tier 2 "In Progress" has wrong type, so tier 3 should pick "Working"
    expect(result).toEqual({ id: "id-working", name: "Working" });
  });
});

// ---------------------------------------------------------------------------
// findStateByType — empty stateMap
// ---------------------------------------------------------------------------

describe("findStateByType – empty stateMap", () => {
  test("returns undefined when stateMap is empty", () => {
    const map: WorkflowStateMap = new Map();
    expect(findStateByType(map, "completed", false)).toBeUndefined();
    expect(findStateByType(map, "started", false)).toBeUndefined();
    expect(findStateByType(map, "canceled", false)).toBeUndefined();
    expect(findStateByType(map, "backlog", false)).toBeUndefined();
  });

  test("returns undefined when no state of the target type exists", () => {
    const map = makeMap([
      { name: "Done", id: "id-done", type: "completed" },
    ]);
    expect(findStateByType(map, "canceled", false)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findStateByType — multiple started states
// ---------------------------------------------------------------------------

describe("findStateByType – multiple started states", () => {
  test("matchReview=true: tier-2 'In Review' preferred when present", () => {
    const map = makeMap([
      { name: "In Progress", id: "id-progress", type: "started" },
      { name: "In Review", id: "id-review", type: "started" },
    ]);
    const result = findStateByType(map, "started", true);
    // Tier 2 conventional name is "In Review" and it exists with correct type
    expect(result).toEqual({ id: "id-review", name: "In Review" });
  });

  test("matchReview=false: tier-2 'In Progress' preferred when present", () => {
    const map = makeMap([
      { name: "In Review", id: "id-review", type: "started" },
      { name: "In Progress", id: "id-progress", type: "started" },
    ]);
    const result = findStateByType(map, "started", false);
    expect(result).toEqual({ id: "id-progress", name: "In Progress" });
  });

  test("matchReview=false: tier-3 picks non-review state when 'In Progress' absent", () => {
    // No "In Progress" — tier 2 fails — tier 3 should pick non-review candidate
    const map = makeMap([
      { name: "In Review", id: "id-review", type: "started" },
      { name: "Working", id: "id-working", type: "started" },
    ]);
    const result = findStateByType(map, "started", false);
    // Should prefer "Working" (non-/review/i) over "In Review"
    expect(result).toEqual({ id: "id-working", name: "Working" });
  });

  test("matchReview=true: tier-3 picks /review/i state when 'In Review' absent", () => {
    // No "In Review" — tier 2 fails — tier 3 should pick a /review/i candidate
    const map = makeMap([
      { name: "Working", id: "id-working", type: "started" },
      { name: "Reviewing", id: "id-reviewing", type: "started" },
    ]);
    const result = findStateByType(map, "started", true);
    // Should prefer "Reviewing" (/review/i) over "Working"
    expect(result).toEqual({ id: "id-reviewing", name: "Reviewing" });
  });

  test("matchReview=true: falls back to first candidate when none match /review/i", () => {
    const map = makeMap([
      { name: "Alpha", id: "id-alpha", type: "started" },
      { name: "Beta", id: "id-beta", type: "started" },
    ]);
    const result = findStateByType(map, "started", true);
    // Neither matches /review/i, so should return first candidate
    expect(result?.name).toBe("Alpha");
  });
});

// ---------------------------------------------------------------------------
// findStateByType — multiple completed states: prefer "Done"
// ---------------------------------------------------------------------------

describe("findStateByType – multiple completed states", () => {
  test("prefers 'Done' via tier-2 over other completed states", () => {
    // Acceptance criteria: "Done Pending Deployment" (completed) and "Done" (completed)
    // — tier-2 conventional name is "Done", so it should be picked
    const map = makeMap([
      { name: "Done Pending Deployment", id: "id-pending", type: "completed" },
      { name: "Done", id: "id-done", type: "completed" },
    ]);
    const result = findStateByType(map, "completed", false);
    expect(result).toEqual({ id: "id-done", name: "Done" });
  });

  test("falls to tier-3 first completed state when 'Done' absent", () => {
    const map = makeMap([
      { name: "Done Pending Deployment", id: "id-pending", type: "completed" },
      { name: "Released", id: "id-released", type: "completed" },
    ]);
    const result = findStateByType(map, "completed", false);
    // No "Done", so tier 3 picks first in iteration order
    expect(result?.name).toBe("Done Pending Deployment");
  });
});

// ---------------------------------------------------------------------------
// writeBackStatus — no API call when state not found (e.g., backlog missing)
// ---------------------------------------------------------------------------

describe("writeBackStatus – no API call when state not found", () => {
  test("does not call updateIssueState when backlog type absent from stateMap", async () => {
    const client = makeMockClient();
    // stateMap has no "backlog" type states
    const map = makeMap([
      { name: "Done", id: "id-done", type: "completed" },
      { name: "Todo", id: "id-todo", type: "unstarted" },
    ]);
    await writeBackStatus(client as any, "TASK-1", "backlog", map);
    expect(client.updateIssueState).not.toHaveBeenCalled();
  });

  test("does not call updateIssueState when canceled type absent from stateMap", async () => {
    const client = makeMockClient();
    const map = makeMap([
      { name: "Done", id: "id-done", type: "completed" },
    ]);
    await writeBackStatus(client as any, "TASK-2", "failed_permanent", map);
    expect(client.updateIssueState).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// writeBackStatus — registerExpectedChange uses resolved state name
// ---------------------------------------------------------------------------

describe("writeBackStatus – registerExpectedChange uses resolved state name", () => {
  beforeEach(() => {
    expectedChanges.clear();
  });

  afterEach(() => {
    expectedChanges.clear();
  });

  test("registers the actual resolved state name, not a hardcoded string", async () => {
    const client = makeMockClient();
    // Use a non-conventional but valid "completed" state name
    const map = makeMap([
      { name: "Shipped", id: "id-shipped", type: "completed" },
    ]);
    await writeBackStatus(client as any, "TASK-3", "done", map);
    // The registered state name should be "Shipped" (the actual resolved name)
    const entry = expectedChanges.get("TASK-3");
    expect(entry?.stateName).toBe("Shipped");
  });

  test("registers 'Done' when it is the resolved state", async () => {
    const client = makeMockClient();
    const map = makeMap([
      { name: "Done", id: "id-done", type: "completed" },
    ]);
    await writeBackStatus(client as any, "TASK-4", "done", map);
    const entry = expectedChanges.get("TASK-4");
    expect(entry?.stateName).toBe("Done");
  });

  test("registers override state name when override exists", async () => {
    const client = makeMockClient();
    const map = makeMap([
      { name: "Done", id: "id-done", type: "completed" },
      { name: "My Custom Done", id: "id-custom", type: "completed" },
    ]);
    const overrides = new Map([["done", "My Custom Done"]]);
    await writeBackStatus(client as any, "TASK-5", "done", map, overrides);
    const entry = expectedChanges.get("TASK-5");
    expect(entry?.stateName).toBe("My Custom Done");
  });

  test("does not register anything when state is not found", async () => {
    const client = makeMockClient();
    const map = makeMap([
      { name: "Done", id: "id-done", type: "completed" },
    ]);
    await writeBackStatus(client as any, "TASK-6", "backlog", map);
    expect(expectedChanges.has("TASK-6")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// writeBackStatus — deploying / awaiting_ci are no-ops
// ---------------------------------------------------------------------------

describe("writeBackStatus – no-op transitions", () => {
  test("deploying does nothing", async () => {
    const client = makeMockClient();
    const map = makeMap([{ name: "Done", id: "id-done", type: "completed" }]);
    await writeBackStatus(client as any, "TASK-7", "deploying", map);
    expect(client.updateIssueState).not.toHaveBeenCalled();
  });

  test("awaiting_ci does nothing", async () => {
    const client = makeMockClient();
    const map = makeMap([{ name: "Done", id: "id-done", type: "completed" }]);
    await writeBackStatus(client as any, "TASK-8", "awaiting_ci", map);
    expect(client.updateIssueState).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// logStartupStateMapping — warning when multiple started states, none /review/i
// ---------------------------------------------------------------------------

describe("logStartupStateMapping – warning behavior", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test("emits warning when multiple started states and none match /review/i", () => {
    const map = makeMap([
      { name: "Working", id: "id-w", type: "started" },
      { name: "In Progress", id: "id-p", type: "started" },
      // Note: "In Progress" matches tier-2 for matchReview=false but NOT /review/i
      // Neither name contains "review"
    ]);
    // Override "In Progress" so it won't match tier-2 default conventional name check,
    // but the warning logic is purely about /review/i across all started state names
    logStartupStateMapping(map);
    const allLogs = consoleSpy.mock.calls.map((c) => String(c[0]));
    const hasWarning = allLogs.some((msg) =>
      msg.includes("warning") && msg.includes("started"),
    );
    expect(hasWarning).toBe(true);
  });

  test("does NOT warn when one of the started states matches /review/i", () => {
    const map = makeMap([
      { name: "In Progress", id: "id-p", type: "started" },
      { name: "In Review", id: "id-r", type: "started" },
    ]);
    logStartupStateMapping(map);
    const allLogs = consoleSpy.mock.calls.map((c) => String(c[0]));
    const hasWarning = allLogs.some((msg) =>
      msg.includes("warning") && msg.includes("started"),
    );
    expect(hasWarning).toBe(false);
  });

  test("does NOT warn when only one started state exists", () => {
    const map = makeMap([
      { name: "In Progress", id: "id-p", type: "started" },
    ]);
    logStartupStateMapping(map);
    const allLogs = consoleSpy.mock.calls.map((c) => String(c[0]));
    const hasWarning = allLogs.some((msg) =>
      msg.includes("warning") && msg.includes("started"),
    );
    expect(hasWarning).toBe(false);
  });

  test("warning message includes the state names", () => {
    const map = makeMap([
      { name: "Alpha", id: "id-a", type: "started" },
      { name: "Beta", id: "id-b", type: "started" },
    ]);
    logStartupStateMapping(map);
    const allLogs = consoleSpy.mock.calls.map((c) => String(c[0]));
    const warningLog = allLogs.find((msg) =>
      msg.includes("warning") && msg.includes("started"),
    );
    expect(warningLog).toBeDefined();
    expect(warningLog).toContain("Alpha");
    expect(warningLog).toContain("Beta");
  });
});

// ---------------------------------------------------------------------------
// writeBackStatus — calls updateIssueState with correct id
// ---------------------------------------------------------------------------

describe("writeBackStatus – correct API call", () => {
  beforeEach(() => {
    expectedChanges.clear();
  });

  afterEach(() => {
    expectedChanges.clear();
  });

  test("calls updateIssueState with the resolved state id", async () => {
    const client = makeMockClient();
    const map = makeMap([
      { name: "Done", id: "state-done-id", type: "completed" },
    ]);
    await writeBackStatus(client as any, "TASK-9", "done", map);
    expect(client.updateIssueState).toHaveBeenCalledWith("TASK-9", "state-done-id");
  });

  test("calls updateIssueState with override state id when override present", async () => {
    const client = makeMockClient();
    const map = makeMap([
      { name: "Done", id: "state-done-id", type: "completed" },
      { name: "Custom Done", id: "state-custom-id", type: "completed" },
    ]);
    const overrides = new Map([["done", "Custom Done"]]);
    await writeBackStatus(client as any, "TASK-10", "done", map, overrides);
    expect(client.updateIssueState).toHaveBeenCalledWith("TASK-10", "state-custom-id");
  });
});

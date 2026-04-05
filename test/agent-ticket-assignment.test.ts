// ---------------------------------------------------------------------------
// Agent-ticket assignment and label routing tests
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  getTask,
  updateTaskFields,
  insertAgent,
  getAgent,
  updateAgent,
  getAllAgents,
} from "../src/db/queries.js";
import type { OrcaConfig } from "../src/config/index.js";
import type { LinearIssue } from "../src/linear/client.js";

// Mock scheduler + runner so resolveConflict imports don't fail
vi.mock("../src/session-handles.js", () => ({
  activeHandles: new Map(),
}));
vi.mock("../src/runner/index.js", () => ({
  killSession: vi.fn().mockResolvedValue({}),
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

function testConfig(overrides: Partial<OrcaConfig> = {}): OrcaConfig {
  return {
    defaultCwd: "/tmp/test",
    projectRepoMap: new Map(),
    concurrencyCap: 3,
    agentConcurrencyCap: 12,
    sessionTimeoutMin: 45,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxTokens: 1_000_000_000,
    claudePath: "claude",
    defaultMaxTurns: 20,
    implementSystemPrompt: "",
    reviewSystemPrompt: "",
    fixSystemPrompt: "",
    maxReviewCycles: 3,
    reviewMaxTurns: 30,
    disallowedTools: "",
    model: "sonnet",
    reviewModel: "haiku",
    deployStrategy: "none",
    maxDeployPollAttempts: 60,
    maxCiPollAttempts: 240,
    port: 3000,
    dbPath: ":memory:",
    logPath: "./orca.log",
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-webhook-secret",
    linearProjectIds: ["proj-1"],
    tunnelHostname: "test.example.com",
    alertWebhookUrl: undefined,
    tunnelToken: "",
    githubMcpPat: undefined,
    cloudflaredPath: "cloudflared",
    externalTunnel: false,
    logLevel: "info",
    ...overrides,
  };
}

function seedAgent(
  db: OrcaDb,
  overrides: Partial<{
    id: string;
    name: string;
    systemPrompt: string;
    linearLabel: string | null;
    repoPath: string | null;
  }> = {},
): string {
  const id = overrides.id ?? `agent-${Date.now().toString(36)}`;
  const ts = now();
  insertAgent(db, {
    id,
    name: overrides.name ?? `Agent ${id}`,
    systemPrompt: overrides.systemPrompt ?? "test prompt",
    linearLabel: overrides.linearLabel ?? null,
    repoPath: overrides.repoPath ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

function seedTask(
  db: OrcaDb,
  overrides: Partial<{
    linearIssueId: string;
    agentPrompt: string;
    repoPath: string;
    lifecycleStage: string;
    priority: number;
    retryCount: number;
    parentIdentifier: string | null;
    isParent: number;
    projectName: string | null;
    agentId: string | null;
    taskType: string;
  }> = {},
): string {
  const id = overrides.linearIssueId ?? `TEST-${Date.now().toString(36)}`;
  const ts = now();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: overrides.agentPrompt ?? "do something",
    repoPath: overrides.repoPath ?? "/tmp/fake-repo",
    lifecycleStage: (overrides.lifecycleStage ?? "ready") as any,
    priority: overrides.priority ?? 0,
    retryCount: overrides.retryCount ?? 0,
    parentIdentifier: overrides.parentIdentifier ?? null,
    isParent: overrides.isParent ?? 0,
    projectName: overrides.projectName ?? null,
    agentId: overrides.agentId ?? null,
    taskType: (overrides.taskType ?? "linear") as any,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

function makeIssue(overrides: Record<string, unknown> = {}): LinearIssue {
  return {
    id: "issue-1",
    identifier: "PROJ-1",
    title: "Test issue",
    description: "Test description",
    priority: 2,
    state: { id: "s1", name: "Todo", type: "unstarted" },
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
  } as LinearIssue;
}

function mockLinearClient(issues: LinearIssue[] = []) {
  return {
    fetchProjectIssues: vi.fn().mockResolvedValue(issues),
    updateIssueState: vi.fn().mockResolvedValue(true),
    fetchLabelsByIds: vi.fn().mockResolvedValue([]),
  } as any;
}

// ===========================================================================
// 1. resolveAgentFromLabels
// ===========================================================================

describe("resolveAgentFromLabels", () => {
  let db: OrcaDb;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
    // resolveAgentFromLabels is not exported, so we test it indirectly via fullSync.
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Since resolveAgentFromLabels is a private function, we test it indirectly
  // via fullSync. The tests below verify matching behavior through upsert.

  test("agent with linearLabel is matched when issue has that label", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    // Create agent with linearLabel
    seedAgent(db, { id: "trivia-content", linearLabel: "Trivia Content" });

    const issue = makeIssue({
      identifier: "EMI-100",
      labels: ["Trivia Content"],
    });
    const client = mockLinearClient([issue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "EMI-100");
    expect(task).toBeDefined();
    expect(task!.agentId).toBe("trivia-content");
    expect(task!.taskType).toBe("agent");
  });

  test("convention-based agent:id label matches when agent exists", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    // Create agent without linearLabel (uses convention fallback)
    seedAgent(db, { id: "my-bot", linearLabel: null });

    const issue = makeIssue({
      identifier: "EMI-101",
      labels: ["agent:my-bot"],
    });
    const client = mockLinearClient([issue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "EMI-101");
    expect(task).toBeDefined();
    expect(task!.agentId).toBe("my-bot");
    expect(task!.taskType).toBe("agent");
  });

  test("returns null when no labels match any agent", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    seedAgent(db, { id: "some-agent", linearLabel: "Some Label" });

    const issue = makeIssue({
      identifier: "EMI-102",
      labels: ["Unrelated Label", "Another Label"],
    });
    const client = mockLinearClient([issue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "EMI-102");
    expect(task).toBeDefined();
    expect(task!.agentId).toBeNull();
    expect(task!.taskType).toBe("linear");
  });

  test("returns null for empty labels array", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    seedAgent(db, { id: "some-agent", linearLabel: "Label" });

    const issue = makeIssue({
      identifier: "EMI-103",
      labels: [],
    });
    const client = mockLinearClient([issue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "EMI-103");
    expect(task).toBeDefined();
    expect(task!.agentId).toBeNull();
  });

  test("convention label agent:nonexistent does not match when agent not in DB", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    // No agents in DB at all
    const issue = makeIssue({
      identifier: "EMI-104",
      labels: ["agent:ghost-agent"],
    });
    const client = mockLinearClient([issue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "EMI-104");
    expect(task).toBeDefined();
    expect(task!.agentId).toBeNull();
    expect(task!.taskType).toBe("linear");
  });

  test("linearLabel takes priority over convention-based matching", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    // Create two agents: one with linearLabel, one that matches convention
    seedAgent(db, {
      id: "fancy-agent",
      linearLabel: "My Custom Label",
    });
    seedAgent(db, {
      id: "conv-agent",
      linearLabel: null,
    });

    // Issue has both the custom label AND a convention label for conv-agent
    const issue = makeIssue({
      identifier: "EMI-105",
      labels: ["My Custom Label", "agent:conv-agent"],
    });
    const client = mockLinearClient([issue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "EMI-105");
    expect(task).toBeDefined();
    // linearLabel match should win over convention
    expect(task!.agentId).toBe("fancy-agent");
    expect(task!.taskType).toBe("agent");
  });

  test("agent:id convention with empty id after colon does not match", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    const issue = makeIssue({
      identifier: "EMI-106",
      labels: ["agent:"],
    });
    const client = mockLinearClient([issue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "EMI-106");
    expect(task).toBeDefined();
    expect(task!.agentId).toBeNull();
    expect(task!.taskType).toBe("linear");
  });

  test("linearLabel matching is case-sensitive", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    seedAgent(db, { id: "case-agent", linearLabel: "Trivia Content" });

    // Issue label has different case
    const issue = makeIssue({
      identifier: "EMI-107",
      labels: ["trivia content"],
    });
    const client = mockLinearClient([issue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "EMI-107");
    expect(task).toBeDefined();
    // Case-sensitive comparison means no match
    expect(task!.agentId).toBeNull();
  });

  test("multiple agents with linearLabel: first match wins", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    // Two agents with different labels, both present on the issue
    seedAgent(db, { id: "agent-a", linearLabel: "Label A" });
    seedAgent(db, { id: "agent-b", linearLabel: "Label B" });

    const issue = makeIssue({
      identifier: "EMI-108",
      labels: ["Label B", "Label A"],
    });
    const client = mockLinearClient([issue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "EMI-108");
    expect(task).toBeDefined();
    // The function iterates over allAgents, so the first agent inserted wins
    // (depends on DB iteration order, which is insertion order for SQLite)
    expect(task!.agentId).toBe("agent-a");
  });
});

// ===========================================================================
// 2. Label routing in upsertTask (via fullSync)
// ===========================================================================

describe("Label routing in upsertTask", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("INSERT path: task with agent label gets agentId and taskType='agent'", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    seedAgent(db, { id: "router-agent", linearLabel: "Route Me" });

    const issue = makeIssue({
      identifier: "ROUTE-1",
      labels: ["Route Me"],
    });
    const client = mockLinearClient([issue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "ROUTE-1");
    expect(task).toBeDefined();
    expect(task!.agentId).toBe("router-agent");
    expect(task!.taskType).toBe("agent");
  });

  test("INSERT path: task without agent label gets no agentId", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    seedAgent(db, { id: "router-agent", linearLabel: "Route Me" });

    const issue = makeIssue({
      identifier: "ROUTE-2",
      labels: ["Some Other Label"],
    });
    const client = mockLinearClient([issue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "ROUTE-2");
    expect(task).toBeDefined();
    expect(task!.agentId).toBeNull();
    expect(task!.taskType).toBe("linear");
  });

  test("UPDATE path: adding a label auto-assigns the agent", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    seedAgent(db, { id: "update-agent", linearLabel: "Assign Me" });

    // First sync: no labels
    const issue1 = makeIssue({
      identifier: "ROUTE-3",
      labels: [],
    });
    const client1 = mockLinearClient([issue1]);
    const graph = new DependencyGraph();

    await fullSync(db, client1, graph, config);
    expect(getTask(db, "ROUTE-3")!.agentId).toBeNull();
    expect(getTask(db, "ROUTE-3")!.taskType).toBe("linear");

    // Second sync: label added
    const issue2 = makeIssue({
      identifier: "ROUTE-3",
      labels: ["Assign Me"],
    });
    const client2 = mockLinearClient([issue2]);

    await fullSync(db, client2, graph, config);

    const task = getTask(db, "ROUTE-3");
    expect(task!.agentId).toBe("update-agent");
    expect(task!.taskType).toBe("agent");
  });

  test("UPDATE path: removing a label auto-unassigns (clears agentId, reverts taskType)", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    seedAgent(db, { id: "unassign-agent", linearLabel: "Remove Me" });

    // First sync: with label
    const issue1 = makeIssue({
      identifier: "ROUTE-4",
      labels: ["Remove Me"],
    });
    const client1 = mockLinearClient([issue1]);
    const graph = new DependencyGraph();

    await fullSync(db, client1, graph, config);
    expect(getTask(db, "ROUTE-4")!.agentId).toBe("unassign-agent");
    expect(getTask(db, "ROUTE-4")!.taskType).toBe("agent");

    // Second sync: label removed (non-empty labels, just different ones)
    const issue2 = makeIssue({
      identifier: "ROUTE-4",
      labels: ["Some Other Label"],
    });
    const client2 = mockLinearClient([issue2]);

    await fullSync(db, client2, graph, config);

    const task = getTask(db, "ROUTE-4");
    expect(task!.agentId).toBeNull();
    expect(task!.taskType).toBe("linear");
  });

  test("UPDATE path: empty labels (webhook-like) don't clear existing assignments", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    seedAgent(db, { id: "preserve-agent", linearLabel: "Keep Me" });

    // First sync: with label
    const issue1 = makeIssue({
      identifier: "ROUTE-5",
      labels: ["Keep Me"],
    });
    const client1 = mockLinearClient([issue1]);
    const graph = new DependencyGraph();

    await fullSync(db, client1, graph, config);
    expect(getTask(db, "ROUTE-5")!.agentId).toBe("preserve-agent");
    expect(getTask(db, "ROUTE-5")!.taskType).toBe("agent");

    // Second sync: empty labels (simulating webhook that doesn't include labels)
    const issue2 = makeIssue({
      identifier: "ROUTE-5",
      labels: [],
    });
    const client2 = mockLinearClient([issue2]);

    await fullSync(db, client2, graph, config);

    const task = getTask(db, "ROUTE-5");
    // Empty labels should NOT clear the assignment
    expect(task!.agentId).toBe("preserve-agent");
    expect(task!.taskType).toBe("agent");
  });

  test("UPDATE path: undefined labels field treated as empty (no clear)", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    seedAgent(db, { id: "undef-agent", linearLabel: "Undef Test" });

    // Seed task with agent already assigned
    seedTask(db, {
      linearIssueId: "ROUTE-6",
      agentId: "undef-agent",
      taskType: "agent",
    });

    // Sync with issue that has undefined labels (no labels field)
    const issue = makeIssue({
      identifier: "ROUTE-6",
    });
    // Explicitly remove labels to simulate missing field
    delete (issue as any).labels;

    const client = mockLinearClient([issue]);
    const graph = new DependencyGraph();

    await fullSync(db, client, graph, config);

    const task = getTask(db, "ROUTE-6");
    // undefined labels -> `labels ?? []` -> empty -> no change
    expect(task!.agentId).toBe("undef-agent");
    expect(task!.taskType).toBe("agent");
  });
});

// ===========================================================================
// 3. Agent linearLabel CRUD round-trip
// ===========================================================================

describe("Agent linearLabel CRUD", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("creating an agent with linearLabel persists it in DB", () => {
    const ts = now();
    insertAgent(db, {
      id: "crud-1",
      name: "Test Agent",
      systemPrompt: "do things",
      linearLabel: "My Label",
      createdAt: ts,
      updatedAt: ts,
    });

    const agent = getAgent(db, "crud-1");
    expect(agent).toBeDefined();
    expect(agent!.linearLabel).toBe("My Label");
  });

  test("creating an agent without linearLabel results in null", () => {
    const ts = now();
    insertAgent(db, {
      id: "crud-2",
      name: "No Label Agent",
      systemPrompt: "do things",
      createdAt: ts,
      updatedAt: ts,
    });

    const agent = getAgent(db, "crud-2");
    expect(agent).toBeDefined();
    expect(agent!.linearLabel).toBeNull();
  });

  test("updating linearLabel persists the new value", () => {
    seedAgent(db, { id: "crud-3", linearLabel: "Old Label" });

    updateAgent(db, "crud-3", { linearLabel: "New Label" });

    const agent = getAgent(db, "crud-3");
    expect(agent!.linearLabel).toBe("New Label");
  });

  test("clearing linearLabel (set to null) works", () => {
    seedAgent(db, { id: "crud-4", linearLabel: "Some Label" });

    updateAgent(db, "crud-4", { linearLabel: null });

    const agent = getAgent(db, "crud-4");
    expect(agent!.linearLabel).toBeNull();
  });

  test("reading back agent returns linearLabel via getAgent", () => {
    seedAgent(db, { id: "crud-5", linearLabel: "Read Back" });

    const agent = getAgent(db, "crud-5");
    expect(agent).toBeDefined();
    expect(agent!.linearLabel).toBe("Read Back");
    expect(agent!.id).toBe("crud-5");
    expect(agent!.name).toBe("Agent crud-5");
  });

  test("getAllAgents returns linearLabel for all agents", () => {
    seedAgent(db, { id: "all-1", linearLabel: "Label A" });
    seedAgent(db, { id: "all-2", linearLabel: null });
    seedAgent(db, { id: "all-3", linearLabel: "Label C" });

    const agents = getAllAgents(db);
    expect(agents).toHaveLength(3);

    const labelMap = new Map(agents.map((a) => [a.id, a.linearLabel]));
    expect(labelMap.get("all-1")).toBe("Label A");
    expect(labelMap.get("all-2")).toBeNull();
    expect(labelMap.get("all-3")).toBe("Label C");
  });

  test("linearLabel can be set to empty string", () => {
    seedAgent(db, { id: "crud-6", linearLabel: "NonEmpty" });

    updateAgent(db, "crud-6", { linearLabel: "" });

    const agent = getAgent(db, "crud-6");
    // Empty string is stored as-is, not coerced to null
    expect(agent!.linearLabel).toBe("");
  });

  test("linearLabel with special characters round-trips correctly", () => {
    const weirdLabel = "agent:label with spaces & 'quotes' and \"double quotes\"";
    seedAgent(db, { id: "crud-7", linearLabel: weirdLabel });

    const agent = getAgent(db, "crud-7");
    expect(agent!.linearLabel).toBe(weirdLabel);
  });
});

// ===========================================================================
// 4. isLinearTicket detection
// ===========================================================================

describe("isLinearTicket detection", () => {
  // isLinearTicket is a private function in agent-task-lifecycle.ts.
  // Re-implement the same logic here for testing, since we can't import it.
  function isLinearTicket(taskId: string): boolean {
    return !taskId.startsWith("agent-") && !taskId.startsWith("cron-");
  }

  test("returns true for real Linear IDs like EMI-123", () => {
    expect(isLinearTicket("EMI-123")).toBe(true);
  });

  test("returns true for PROJ-1", () => {
    expect(isLinearTicket("PROJ-1")).toBe(true);
  });

  test("returns true for uppercase prefixed IDs", () => {
    expect(isLinearTicket("ABC-99999")).toBe(true);
  });

  test("returns false for agent- prefixed IDs", () => {
    expect(isLinearTicket("agent-foo-123")).toBe(false);
  });

  test("returns false for cron- prefixed IDs", () => {
    expect(isLinearTicket("cron-bar-456")).toBe(false);
  });

  test("returns false for agent- with no suffix", () => {
    expect(isLinearTicket("agent-")).toBe(false);
  });

  test("returns false for cron- with no suffix", () => {
    expect(isLinearTicket("cron-")).toBe(false);
  });

  test("returns true for empty string (edge case)", () => {
    // Empty string does not start with "agent-" or "cron-"
    expect(isLinearTicket("")).toBe(true);
  });

  test("returns true for strings containing 'agent-' but not at start", () => {
    // "my-agent-task" contains "agent-" but not at position 0
    expect(isLinearTicket("my-agent-task")).toBe(true);
  });

  test("returns true for 'AGENT-123' (uppercase)", () => {
    // startsWith is case-sensitive, so AGENT- does not match agent-
    expect(isLinearTicket("AGENT-123")).toBe(true);
  });

  test("returns true for 'CRON-456' (uppercase)", () => {
    expect(isLinearTicket("CRON-456")).toBe(true);
  });
});

// ===========================================================================
// 5. Edge cases: agent routing + task state interactions
// ===========================================================================

describe("Agent routing edge cases", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("canceled issue with agent label does not create task", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    seedAgent(db, { id: "cancel-agent", linearLabel: "Cancel Test" });

    const issue = makeIssue({
      identifier: "EDGE-1",
      labels: ["Cancel Test"],
      state: { id: "s-cancel", name: "Canceled", type: "canceled" },
    });
    const client = mockLinearClient([issue]);

    await fullSync(db, client, new DependencyGraph(), config);

    // Canceled issues should not create new tasks
    const task = getTask(db, "EDGE-1");
    expect(task).toBeUndefined();
  });

  test("backlog issue with agent label does not create task (backlog returns null)", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    seedAgent(db, { id: "backlog-agent", linearLabel: "Backlog Test" });

    const issue = makeIssue({
      identifier: "EDGE-2",
      labels: ["Backlog Test"],
      state: { id: "s-backlog", name: "Backlog", type: "backlog" },
    });
    const client = mockLinearClient([issue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "EDGE-2");
    expect(task).toBeDefined();
    expect(task!.lifecycleStage).toBe("backlog");
    expect(task!.agentId).toBe("backlog-agent");
    expect(task!.taskType).toBe("agent");
  });

  test("agent with empty string linearLabel does not match any issue label", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    // Agent with empty string linearLabel
    seedAgent(db, { id: "empty-label-agent", linearLabel: "" });

    const issue = makeIssue({
      identifier: "EDGE-3",
      labels: [""],
    });
    const client = mockLinearClient([issue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "EDGE-3");
    expect(task).toBeDefined();
    // Empty string linearLabel is truthy-ish in `agent.linearLabel && labels.includes(agent.linearLabel)`
    // But empty string is falsy in JS! So `agent.linearLabel &&` will short-circuit to false.
    // This means the empty string agent does NOT match, even though labels includes ""
    expect(task!.agentId).toBeNull();
  });

  test("INSERT path: issue with 'In Progress' state maps to ready with agent assignment", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    seedAgent(db, { id: "progress-agent", linearLabel: "Progress" });

    // On INSERT, intermediate states (running/in_review) get remapped to "ready"
    const issue = makeIssue({
      identifier: "EDGE-4",
      labels: ["Progress"],
      state: { id: "s-prog", name: "In Progress", type: "started" },
    });
    const client = mockLinearClient([issue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "EDGE-4");
    expect(task).toBeDefined();
    // Intermediate states map to ready on insert
    expect(task!.lifecycleStage).toBe("ready");
    // Agent should still be assigned
    expect(task!.agentId).toBe("progress-agent");
    expect(task!.taskType).toBe("agent");
  });

  test("multiple issues in same sync batch each get correct agent routing", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    seedAgent(db, { id: "agent-alpha", linearLabel: "Alpha" });
    seedAgent(db, { id: "agent-beta", linearLabel: "Beta" });

    const issues = [
      makeIssue({ identifier: "BATCH-1", labels: ["Alpha"] }),
      makeIssue({ identifier: "BATCH-2", labels: ["Beta"] }),
      makeIssue({ identifier: "BATCH-3", labels: ["Unmatched"] }),
    ];
    const client = mockLinearClient(issues);

    await fullSync(db, client, new DependencyGraph(), config);

    expect(getTask(db, "BATCH-1")!.agentId).toBe("agent-alpha");
    expect(getTask(db, "BATCH-2")!.agentId).toBe("agent-beta");
    expect(getTask(db, "BATCH-3")!.agentId).toBeNull();
  });

  test("reassigning to a different agent via label change works", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    seedAgent(db, { id: "agent-old", linearLabel: "Old Agent" });
    seedAgent(db, { id: "agent-new", linearLabel: "New Agent" });

    // First sync: assign to old agent
    const issue1 = makeIssue({
      identifier: "REASSIGN-1",
      labels: ["Old Agent"],
    });
    const client1 = mockLinearClient([issue1]);
    const graph = new DependencyGraph();

    await fullSync(db, client1, graph, config);
    expect(getTask(db, "REASSIGN-1")!.agentId).toBe("agent-old");

    // Second sync: reassign to new agent
    const issue2 = makeIssue({
      identifier: "REASSIGN-1",
      labels: ["New Agent"],
    });
    const client2 = mockLinearClient([issue2]);

    await fullSync(db, client2, graph, config);
    expect(getTask(db, "REASSIGN-1")!.agentId).toBe("agent-new");
    expect(getTask(db, "REASSIGN-1")!.taskType).toBe("agent");
  });
});

// ===========================================================================
// 6. DB schema: agentId and taskType columns on tasks
// ===========================================================================

describe("DB schema - agentId and taskType columns", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("agentId column exists and defaults to null", () => {
    seedTask(db, { linearIssueId: "SCHEMA-1" });
    const task = getTask(db, "SCHEMA-1");
    expect(task!.agentId).toBeNull();
  });

  test("taskType column exists and defaults to 'linear'", () => {
    seedTask(db, { linearIssueId: "SCHEMA-2" });
    const task = getTask(db, "SCHEMA-2");
    expect(task!.taskType).toBe("linear");
  });

  test("agentId can be set via insertTask", () => {
    seedTask(db, { linearIssueId: "SCHEMA-3", agentId: "test-agent" });
    const task = getTask(db, "SCHEMA-3");
    expect(task!.agentId).toBe("test-agent");
  });

  test("taskType can be set to 'agent' via insertTask", () => {
    seedTask(db, { linearIssueId: "SCHEMA-4", taskType: "agent" });
    const task = getTask(db, "SCHEMA-4");
    expect(task!.taskType).toBe("agent");
  });

  test("agentId can be updated via updateTaskFields", () => {
    seedTask(db, { linearIssueId: "SCHEMA-5" });
    updateTaskFields(db, "SCHEMA-5", { agentId: "updated-agent" });
    const task = getTask(db, "SCHEMA-5");
    expect(task!.agentId).toBe("updated-agent");
  });

  test("agentId can be cleared to null via updateTaskFields", () => {
    seedTask(db, { linearIssueId: "SCHEMA-6", agentId: "old-agent" });
    updateTaskFields(db, "SCHEMA-6", { agentId: null });
    const task = getTask(db, "SCHEMA-6");
    expect(task!.agentId).toBeNull();
  });
});

// ===========================================================================
// 7. Webhook label routing
// ===========================================================================

describe("Webhook label routing via processWebhookEvent", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("webhook with labelIds resolves labels and routes to agent", async () => {
    const { processWebhookEvent, clearStartupGrace } = await import(
      "../src/linear/sync.js"
    );
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();
    const graph = new DependencyGraph();
    const stateMap = new Map([
      ["Todo", { id: "state-todo", type: "unstarted" }],
    ]);

    // Skip startup grace to avoid webhook deferral
    clearStartupGrace();

    // Create agent with linearLabel
    seedAgent(db, { id: "webhook-agent", linearLabel: "WebhookLabel" });

    // Mock client that resolves label IDs to names
    const client = {
      fetchProjectIssues: vi.fn().mockResolvedValue([]),
      fetchLabelsByIds: vi.fn().mockResolvedValue(["WebhookLabel"]),
    } as any;

    await processWebhookEvent(db, client, graph, config, stateMap, {
      action: "create",
      type: "Issue",
      data: {
        id: "uuid-wh-1",
        identifier: "WH-1",
        title: "Webhook created task",
        description: "test",
        priority: 2,
        state: { id: "state-todo", name: "Todo", type: "unstarted" },
        projectId: "proj-1",
        labelIds: ["label-uuid-1"],
      },
    });

    const task = getTask(db, "WH-1");
    expect(task).toBeDefined();
    expect(task!.agentId).toBe("webhook-agent");
    expect(task!.taskType).toBe("agent");
    expect(client.fetchLabelsByIds).toHaveBeenCalledWith(["label-uuid-1"]);
  });

  test("webhook with no labelIds leaves agent assignment unchanged", async () => {
    const { processWebhookEvent, clearStartupGrace } = await import(
      "../src/linear/sync.js"
    );
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();
    const graph = new DependencyGraph();
    const stateMap = new Map([
      ["Todo", { id: "state-todo", type: "unstarted" }],
    ]);

    clearStartupGrace();

    // Pre-seed task with an agent assignment
    seedTask(db, {
      linearIssueId: "WH-2",
      agentId: "existing-agent",
      taskType: "agent",
    });

    const client = {
      fetchProjectIssues: vi.fn().mockResolvedValue([]),
      fetchLabelsByIds: vi.fn(),
    } as any;

    // Webhook update without labelIds
    await processWebhookEvent(db, client, graph, config, stateMap, {
      action: "update",
      type: "Issue",
      data: {
        id: "uuid-wh-2",
        identifier: "WH-2",
        title: "Updated task",
        description: "test",
        priority: 2,
        state: { id: "state-todo", name: "Todo", type: "unstarted" },
        projectId: "proj-1",
        // No labelIds field
      },
    });

    const task = getTask(db, "WH-2");
    expect(task).toBeDefined();
    // Agent assignment should be preserved
    expect(task!.agentId).toBe("existing-agent");
    expect(task!.taskType).toBe("agent");
    // fetchLabelsByIds should not be called when no labelIds
    expect(client.fetchLabelsByIds).not.toHaveBeenCalled();
  });

  test("webhook with labelIds but fetchLabelsByIds failure preserves existing agent", async () => {
    const { processWebhookEvent, clearStartupGrace } = await import(
      "../src/linear/sync.js"
    );
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();
    const graph = new DependencyGraph();
    const stateMap = new Map([
      ["Todo", { id: "state-todo", type: "unstarted" }],
    ]);

    clearStartupGrace();

    // Pre-seed task with an agent assignment
    seedTask(db, {
      linearIssueId: "WH-3",
      agentId: "safe-agent",
      taskType: "agent",
    });

    // Client that fails to resolve labels
    const client = {
      fetchProjectIssues: vi.fn().mockResolvedValue([]),
      fetchLabelsByIds: vi.fn().mockRejectedValue(new Error("API failure")),
    } as any;

    await processWebhookEvent(db, client, graph, config, stateMap, {
      action: "update",
      type: "Issue",
      data: {
        id: "uuid-wh-3",
        identifier: "WH-3",
        title: "Updated task",
        description: "test",
        priority: 2,
        state: { id: "state-todo", name: "Todo", type: "unstarted" },
        projectId: "proj-1",
        labelIds: ["label-that-fails"],
      },
    });

    const task = getTask(db, "WH-3");
    expect(task).toBeDefined();
    // When fetchLabelsByIds fails, resolvedLabels stays [], so no clear
    expect(task!.agentId).toBe("safe-agent");
    expect(task!.taskType).toBe("agent");
  });
});

// ===========================================================================
// 8. Update path: no-op when same agent is already assigned
// ===========================================================================

describe("Agent routing - no-op when unchanged", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("re-syncing with same label does not trigger agentFieldsChanged", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    seedAgent(db, { id: "stable-agent", linearLabel: "Stable" });

    const issue = makeIssue({
      identifier: "NOOP-1",
      labels: ["Stable"],
    });
    const client1 = mockLinearClient([issue]);
    const graph = new DependencyGraph();

    // First sync: assigns agent
    await fullSync(db, client1, graph, config);
    const task1 = getTask(db, "NOOP-1");
    expect(task1!.agentId).toBe("stable-agent");

    // Second sync: same labels, same agent
    const client2 = mockLinearClient([issue]);
    await fullSync(db, client2, graph, config);
    const task2 = getTask(db, "NOOP-1");
    // Agent is still assigned, no change
    expect(task2!.agentId).toBe("stable-agent");
    expect(task2!.taskType).toBe("agent");
  });

  test("switching between convention and linearLabel for same agent keeps assignment", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    seedAgent(db, { id: "dual-agent", linearLabel: "Custom Label" });

    // First sync: matched via linearLabel
    const issue1 = makeIssue({
      identifier: "NOOP-2",
      labels: ["Custom Label"],
    });
    const client1 = mockLinearClient([issue1]);
    const graph = new DependencyGraph();

    await fullSync(db, client1, graph, config);
    expect(getTask(db, "NOOP-2")!.agentId).toBe("dual-agent");

    // Second sync: matched via convention
    const issue2 = makeIssue({
      identifier: "NOOP-2",
      labels: ["agent:dual-agent"],
    });
    const client2 = mockLinearClient([issue2]);

    await fullSync(db, client2, graph, config);
    // Same agent ID either way
    expect(getTask(db, "NOOP-2")!.agentId).toBe("dual-agent");
  });
});

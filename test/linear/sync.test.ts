// ---------------------------------------------------------------------------
// Tests for ORCA_TASK_FILTER_LABEL behavior in fullSync and processWebhookEvent
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must come before any imports that pull in these modules
// ---------------------------------------------------------------------------

vi.mock("../../src/db/queries.js", () => ({
  getTask: vi.fn(),
  getChildTasks: vi.fn(() => []),
  getParentTasks: vi.fn(() => []),
  insertTask: vi.fn(),
  updateTaskStatus: vi.fn(),
  updateTaskFields: vi.fn(),
  updateInvocation: vi.fn(),
  getRunningInvocations: vi.fn(() => []),
}));

vi.mock("../../src/scheduler/index.js", () => ({
  activeHandles: new Map(),
}));

vi.mock("../../src/runner/index.js", () => ({
  killSession: vi.fn(),
}));

vi.mock("../../src/github/index.js", () => ({
  closePrsForCanceledTask: vi.fn(),
}));

vi.mock("../../src/events.js", () => ({
  emitTaskUpdated: vi.fn(),
  emitTasksRefreshed: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { fullSync, processWebhookEvent, labelIdCache } from "../../src/linear/sync.js";
import type { WebhookEvent } from "../../src/linear/sync.js";
import type { LinearIssue } from "../../src/linear/client.js";
import type { OrcaConfig } from "../../src/config/index.js";
import { DependencyGraph } from "../../src/linear/graph.js";
import {
  insertTask,
  updateTaskFields,
  updateTaskStatus,
  getTask,
} from "../../src/db/queries.js";
import { emitTasksRefreshed, emitTaskUpdated } from "../../src/events.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(taskFilterLabel?: string): OrcaConfig {
  return {
    defaultCwd: "/tmp/repo",
    projectRepoMap: new Map([["proj-1", "/tmp/repo"]]),
    concurrencyCap: 1,
    sessionTimeoutMin: 45,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxCostUsd: 1000,
    schedulerIntervalSec: 10,
    claudePath: "claude",
    defaultMaxTurns: 50,
    implementSystemPrompt: "",
    reviewSystemPrompt: "",
    fixSystemPrompt: "",
    maxReviewCycles: 3,
    reviewMaxTurns: 30,
    disallowedTools: "",
    implementModel: "sonnet",
    reviewModel: "haiku",
    fixModel: "sonnet",
    deployStrategy: "none",
    deployPollIntervalSec: 30,
    deployTimeoutMin: 30,
    cleanupIntervalMin: 10,
    cleanupBranchMaxAgeMin: 60,
    resumeOnMaxTurns: true,
    resumeOnFix: true,
    maxWorktreeRetries: 3,
    port: 3000,
    dbPath: ":memory:",
    logPath: "./orca.log",
    logMaxSizeMb: 10,
    linearApiKey: "test-key",
    linearWebhookSecret: "test-secret",
    linearProjectIds: ["proj-1"],
    taskFilterLabel,
    tunnelHostname: "test.example.com",
    githubWebhookSecret: undefined,
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    externalTunnel: false,
  };
}

function makeIssue(
  identifier: string,
  labels: string[],
  stateName = "Todo",
): LinearIssue {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `Issue ${identifier}`,
    description: "Test description",
    priority: 2,
    state: { id: `state-${stateName}`, name: stateName, type: "started" },
    teamId: "team-1",
    projectId: "proj-1",
    projectName: "Test Project",
    relations: [],
    inverseRelations: [],
    parentId: null,
    parentTitle: null,
    parentDescription: null,
    childIds: [],
    labels,
  };
}

function makeMockClient(issues: LinearIssue[], labelId?: string) {
  return {
    fetchProjectIssues: vi.fn().mockResolvedValue(issues),
    fetchLabelId: vi.fn().mockResolvedValue(labelId),
    fetchWorkflowStates: vi.fn().mockResolvedValue(new Map()),
    updateIssueState: vi.fn().mockResolvedValue(true),
  };
}

// A minimal stand-in for OrcaDb — sync.ts passes it to query functions but
// those are fully mocked, so we only need the shape to satisfy TypeScript.
const mockDb = {} as ReturnType<typeof import("../../src/db/index.js").createDb>;

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  labelIdCache.clear();
});

// ---------------------------------------------------------------------------
// fullSync tests
// ---------------------------------------------------------------------------

describe("fullSync — label filtering", () => {
  it("upserts only labeled issues when taskFilterLabel is set", async () => {
    const config = makeConfig("orca");
    const issues = [
      makeIssue("ABC-1", ["orca"]),
      makeIssue("ABC-2", ["other"]),
      makeIssue("ABC-3", []),
      makeIssue("ABC-4", ["orca", "other"]),
    ];
    const client = makeMockClient(issues, "label-uuid-123");
    const graph = new DependencyGraph();

    // No tasks exist yet
    vi.mocked(getTask).mockReturnValue(undefined);

    const count = await fullSync(mockDb, client as any, graph, config);

    expect(count).toBe(2);

    // insertTask should be called exactly twice: ABC-1 and ABC-4
    const insertedIds = vi
      .mocked(insertTask)
      .mock.calls.map((call) => call[1].linearIssueId);
    expect(insertedIds).toContain("ABC-1");
    expect(insertedIds).toContain("ABC-4");
    expect(insertedIds).not.toContain("ABC-2");
    expect(insertedIds).not.toContain("ABC-3");
  });

  it("upserts all issues when taskFilterLabel is undefined", async () => {
    const config = makeConfig(undefined);
    const issues = [
      makeIssue("DEF-1", []),
      makeIssue("DEF-2", ["some-label"]),
      makeIssue("DEF-3", ["other"]),
    ];
    const client = makeMockClient(issues);
    const graph = new DependencyGraph();

    vi.mocked(getTask).mockReturnValue(undefined);

    const count = await fullSync(mockDb, client as any, graph, config);

    expect(count).toBe(3);
    expect(insertTask).toHaveBeenCalledTimes(3);
  });

  it("skips fetchLabelId when taskFilterLabel is undefined", async () => {
    const config = makeConfig(undefined);
    const client = makeMockClient([]);
    const graph = new DependencyGraph();

    await fullSync(mockDb, client as any, graph, config);

    expect(client.fetchLabelId).not.toHaveBeenCalled();
  });

  it("populates labelIdCache when taskFilterLabel is set and label is found", async () => {
    const config = makeConfig("orca");
    const client = makeMockClient([], "label-uuid-abc");
    const graph = new DependencyGraph();

    await fullSync(mockDb, client as any, graph, config);

    expect(labelIdCache.get("orca")).toBe("label-uuid-abc");
  });

  it("clears labelIdCache entry when label is not found in Linear", async () => {
    // Pre-seed a stale cache entry
    labelIdCache.set("orca", "stale-uuid");

    const config = makeConfig("orca");
    // fetchLabelId returns undefined — label not found
    const client = makeMockClient([], undefined);
    const graph = new DependencyGraph();

    await fullSync(mockDb, client as any, graph, config);

    expect(labelIdCache.has("orca")).toBe(false);
  });

  it("emits tasksRefreshed regardless of filter", async () => {
    const config = makeConfig("orca");
    const client = makeMockClient([], "label-uuid");
    const graph = new DependencyGraph();

    await fullSync(mockDb, client as any, graph, config);

    expect(emitTasksRefreshed).toHaveBeenCalledOnce();
  });

  it("returns 0 when all issues lack the filter label", async () => {
    const config = makeConfig("orca");
    const issues = [makeIssue("XYZ-1", []), makeIssue("XYZ-2", ["other"])];
    const client = makeMockClient(issues, "label-uuid-xyz");
    const graph = new DependencyGraph();

    vi.mocked(getTask).mockReturnValue(undefined);

    const count = await fullSync(mockDb, client as any, graph, config);

    expect(count).toBe(0);
    expect(insertTask).not.toHaveBeenCalled();
  });

  it("does not call updateTaskFields for filtered-out issues", async () => {
    const config = makeConfig("orca");
    const existingTask = {
      linearIssueId: "SKIP-1",
      agentPrompt: "old prompt",
      repoPath: "/tmp/repo",
      orcaStatus: "ready",
      priority: 2,
      retryCount: 0,
      reviewCycleCount: 0,
      mergeAttemptCount: 0,
      staleSessionRetryCount: 0,
      isParent: 0,
      parentIdentifier: null,
      prBranchName: null,
      mergeCommitSha: null,
      prNumber: null,
      deployStartedAt: null,
      ciStartedAt: null,
      doneAt: null,
      fixReason: null,
      projectName: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Unlabeled issue that already exists in DB
    const issues = [makeIssue("SKIP-1", ["wrong-label"])];
    const client = makeMockClient(issues, "label-uuid-123");
    const graph = new DependencyGraph();

    vi.mocked(getTask).mockReturnValue(existingTask as any);

    await fullSync(mockDb, client as any, graph, config);

    // Neither insert nor update should happen for the filtered-out issue
    expect(insertTask).not.toHaveBeenCalled();
    expect(updateTaskFields).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processWebhookEvent tests
// ---------------------------------------------------------------------------

describe("processWebhookEvent — label filtering", () => {
  const stateMap = new Map([
    ["Todo", { id: "state-todo", type: "unstarted" }],
    ["In Progress", { id: "state-inprogress", type: "started" }],
  ]);

  function makeWebhookEvent(labelIds: string[], stateName = "Todo"): WebhookEvent {
    return {
      action: "update",
      type: "Issue",
      data: {
        id: "issue-id-1",
        identifier: "WH-1",
        title: "Webhook Issue",
        description: "desc",
        priority: 2,
        state: { id: "state-todo", name: stateName, type: "unstarted" },
        teamId: "team-1",
        projectId: "proj-1",
        labelIds,
      },
    };
  }

  it("skips webhook when label filter is active and issue lacks the required label", async () => {
    const config = makeConfig("orca");
    labelIdCache.set("orca", "label-uuid-123");

    const client = makeMockClient([]);
    const graph = new DependencyGraph();
    const event = makeWebhookEvent([]); // no label IDs

    vi.mocked(getTask).mockReturnValue(undefined);

    await processWebhookEvent(
      mockDb,
      client as any,
      graph,
      config,
      stateMap,
      event,
    );

    // Neither insert nor update should have been called
    expect(insertTask).not.toHaveBeenCalled();
    expect(updateTaskFields).not.toHaveBeenCalled();
    expect(updateTaskStatus).not.toHaveBeenCalled();
    expect(emitTaskUpdated).not.toHaveBeenCalled();
  });

  it("processes webhook when label filter is active and issue has the required label", async () => {
    const config = makeConfig("orca");
    labelIdCache.set("orca", "label-uuid-123");

    const client = makeMockClient([]);
    const graph = new DependencyGraph();
    const event = makeWebhookEvent(["label-uuid-123"]); // correct label

    // No pre-existing task
    vi.mocked(getTask).mockReturnValue(undefined);

    await processWebhookEvent(
      mockDb,
      client as any,
      graph,
      config,
      stateMap,
      event,
    );

    // insertTask should be called (new issue with "Todo" → "ready")
    expect(insertTask).toHaveBeenCalledOnce();
  });

  it("processes webhook when taskFilterLabel is undefined regardless of labelIds", async () => {
    const config = makeConfig(undefined);

    const client = makeMockClient([]);
    const graph = new DependencyGraph();
    const event = makeWebhookEvent([]); // no labels — but filter is off

    vi.mocked(getTask).mockReturnValue(undefined);

    await processWebhookEvent(
      mockDb,
      client as any,
      graph,
      config,
      stateMap,
      event,
    );

    // Should proceed to upsert
    expect(insertTask).toHaveBeenCalledOnce();
  });

  it("does not filter webhook when labelIdCache has no entry for the label", async () => {
    // Filter is set but labelIdCache hasn't been populated (e.g., fullSync not run yet,
    // or label didn't resolve). Per implementation: if requiredLabelId is falsy, skip
    // the check and process the webhook.
    const config = makeConfig("orca");
    // labelIdCache is clear (not populated in this test)

    const client = makeMockClient([]);
    const graph = new DependencyGraph();
    const event = makeWebhookEvent([]); // no labels

    vi.mocked(getTask).mockReturnValue(undefined);

    await processWebhookEvent(
      mockDb,
      client as any,
      graph,
      config,
      stateMap,
      event,
    );

    // Because labelIdCache has no entry, the filter is bypassed and upsert proceeds
    expect(insertTask).toHaveBeenCalledOnce();
  });

  it("skips webhook when event has multiple labelIds but none match the required one", async () => {
    const config = makeConfig("orca");
    labelIdCache.set("orca", "label-uuid-123");

    const client = makeMockClient([]);
    const graph = new DependencyGraph();
    const event = makeWebhookEvent(["wrong-uuid-a", "wrong-uuid-b"]);

    vi.mocked(getTask).mockReturnValue(undefined);

    await processWebhookEvent(
      mockDb,
      client as any,
      graph,
      config,
      stateMap,
      event,
    );

    expect(insertTask).not.toHaveBeenCalled();
    expect(updateTaskFields).not.toHaveBeenCalled();
  });

  it("processes webhook when event has multiple labelIds and one matches", async () => {
    const config = makeConfig("orca");
    labelIdCache.set("orca", "label-uuid-123");

    const client = makeMockClient([]);
    const graph = new DependencyGraph();
    const event = makeWebhookEvent(["other-uuid", "label-uuid-123"]);

    vi.mocked(getTask).mockReturnValue(undefined);

    await processWebhookEvent(
      mockDb,
      client as any,
      graph,
      config,
      stateMap,
      event,
    );

    expect(insertTask).toHaveBeenCalledOnce();
  });

  it("skips webhook when event.data.labelIds is undefined (treated as empty)", async () => {
    // labelIds is optional in the WebhookEvent type — test the undefined path
    const config = makeConfig("orca");
    labelIdCache.set("orca", "label-uuid-123");

    const client = makeMockClient([]);
    const graph = new DependencyGraph();
    const event: WebhookEvent = {
      action: "update",
      type: "Issue",
      data: {
        id: "issue-id-2",
        identifier: "WH-2",
        title: "No labelIds field",
        priority: 1,
        state: { id: "state-todo", name: "Todo", type: "unstarted" },
        // labelIds is intentionally omitted
      },
    };

    vi.mocked(getTask).mockReturnValue(undefined);

    await processWebhookEvent(
      mockDb,
      client as any,
      graph,
      config,
      stateMap,
      event,
    );

    expect(insertTask).not.toHaveBeenCalled();
    expect(emitTaskUpdated).not.toHaveBeenCalled();
  });

  it("remove action skips upsert even when label matches", async () => {
    // 'remove' webhooks return early before any DB write, regardless of label filter.
    // This test verifies that behavior is preserved with label filtering active.
    const config = makeConfig("orca");
    labelIdCache.set("orca", "label-uuid-123");

    const client = makeMockClient([]);
    const graph = new DependencyGraph();
    const event: WebhookEvent = {
      action: "remove",
      type: "Issue",
      data: {
        id: "issue-id-3",
        identifier: "WH-3",
        title: "Removed",
        priority: 1,
        state: { id: "state-todo", name: "Todo", type: "unstarted" },
        labelIds: ["label-uuid-123"],
      },
    };

    vi.mocked(getTask).mockReturnValue(undefined);

    await processWebhookEvent(
      mockDb,
      client as any,
      graph,
      config,
      stateMap,
      event,
    );

    expect(insertTask).not.toHaveBeenCalled();
    expect(updateTaskFields).not.toHaveBeenCalled();
    expect(emitTaskUpdated).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Edge case: label filter with exact string matching
// ---------------------------------------------------------------------------

describe("fullSync — label filter uses exact string match", () => {
  it("does not match label names as substrings (orca vs orca-special)", async () => {
    const config = makeConfig("orca");
    const issues = [
      makeIssue("EXACT-1", ["orca-special"]), // should NOT match
      makeIssue("EXACT-2", ["orca"]),           // should match
    ];
    const client = makeMockClient(issues, "label-uuid-exact");
    const graph = new DependencyGraph();

    vi.mocked(getTask).mockReturnValue(undefined);

    const count = await fullSync(mockDb, client as any, graph, config);

    expect(count).toBe(1);
    const insertedIds = vi
      .mocked(insertTask)
      .mock.calls.map((call) => call[1].linearIssueId);
    expect(insertedIds).toContain("EXACT-2");
    expect(insertedIds).not.toContain("EXACT-1");
  });
});

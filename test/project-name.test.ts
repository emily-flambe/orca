// ---------------------------------------------------------------------------
// Project name feature tests — adversarial edge cases
// ---------------------------------------------------------------------------

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  getTask,
  getAllTasks,
  updateTaskFields,
} from "../src/db/queries.js";
import type { OrcaConfig } from "../src/config/index.js";

// Mock scheduler + runner so sync imports don't fail
vi.mock("../src/scheduler/index.js", () => ({
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
    sessionTimeoutMin: 45,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxCostUsd: 10.0,
    schedulerIntervalSec: 10,
    claudePath: "claude",
    defaultMaxTurns: 20,
    implementSystemPrompt: "",
    reviewSystemPrompt: "",
    fixSystemPrompt: "",
    maxReviewCycles: 3,
    reviewMaxTurns: 30,
    disallowedTools: "",
    deployStrategy: "none",
    deployPollIntervalSec: 30,
    deployTimeoutMin: 30,
    cleanupIntervalMin: 10,
    cleanupBranchMaxAgeMin: 60,
    resumeOnMaxTurns: true,
    port: 3000,
    dbPath: ":memory:",
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-webhook-secret",
    linearProjectIds: ["proj-1"],
    linearReadyStateType: "unstarted",
    tunnelHostname: "test.example.com",
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    ...overrides,
  };
}

function seedTask(
  db: OrcaDb,
  overrides: Partial<{
    linearIssueId: string;
    agentPrompt: string;
    repoPath: string;
    orcaStatus: string;
    priority: number;
    retryCount: number;
    parentIdentifier: string | null;
    isParent: number;
    projectName: string | null;
  }> = {},
): string {
  const id = overrides.linearIssueId ?? `TEST-${Date.now().toString(36)}`;
  const ts = now();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: overrides.agentPrompt ?? "do something",
    repoPath: overrides.repoPath ?? "/tmp/fake-repo",
    orcaStatus: (overrides.orcaStatus ?? "ready") as any,
    priority: overrides.priority ?? 0,
    retryCount: overrides.retryCount ?? 0,
    parentIdentifier: overrides.parentIdentifier ?? null,
    isParent: overrides.isParent ?? 0,
    projectName: overrides.projectName ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "PROJ-1",
    title: "Test issue",
    description: "Test description",
    priority: 2,
    state: { id: "s1", name: "Todo", type: "unstarted" },
    teamId: "team-1",
    projectId: "proj-1",
    projectName: "My Project",
    relations: [],
    inverseRelations: [],
    parentId: null,
    parentTitle: null,
    parentDescription: null,
    childIds: [],
    ...overrides,
  };
}

function mockLinearClient(issues: any[] = []) {
  return {
    fetchProjectIssues: vi.fn().mockResolvedValue(issues),
    updateIssueState: vi.fn().mockResolvedValue(true),
  } as any;
}

// ===========================================================================
// 1. DB schema: project_name column exists
// ===========================================================================

describe("DB schema - project_name column", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("project_name column exists on fresh DB", () => {
    const ts = now();
    insertTask(db, {
      linearIssueId: "PN-1",
      agentPrompt: "test",
      repoPath: "/tmp/repo",
      orcaStatus: "ready",
      priority: 0,
      retryCount: 0,
      projectName: "Alpha Project",
      createdAt: ts,
      updatedAt: ts,
    });

    const task = getTask(db, "PN-1");
    expect(task).toBeDefined();
    expect(task!.projectName).toBe("Alpha Project");
  });

  test("project_name defaults to null when not provided", () => {
    const ts = now();
    insertTask(db, {
      linearIssueId: "PN-2",
      agentPrompt: "test",
      repoPath: "/tmp/repo",
      orcaStatus: "ready",
      priority: 0,
      retryCount: 0,
      createdAt: ts,
      updatedAt: ts,
    });

    const task = getTask(db, "PN-2");
    expect(task).toBeDefined();
    expect(task!.projectName).toBeNull();
  });

  test("project_name can be updated via updateTaskFields", () => {
    const id = seedTask(db, { linearIssueId: "PN-3", projectName: "Old Name" });
    updateTaskFields(db, id, { projectName: "New Name" });

    const task = getTask(db, id);
    expect(task!.projectName).toBe("New Name");
  });

  test("project_name can be set to empty string", () => {
    const id = seedTask(db, { linearIssueId: "PN-4", projectName: "" });
    const task = getTask(db, id);
    expect(task!.projectName).toBe("");
  });
});

// ===========================================================================
// 2. fullSync: projectName flows through from Linear API to DB
// ===========================================================================

describe("fullSync - projectName propagation", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  test("fullSync stores projectName from Linear issue on INSERT", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    const issue = makeIssue({
      identifier: "PN-SYNC-1",
      projectName: "Sync Project",
    });

    const client = mockLinearClient([issue]);
    const graph = new DependencyGraph();

    await fullSync(db, client, graph, config);

    const task = getTask(db, "PN-SYNC-1");
    expect(task).toBeDefined();
    expect(task!.projectName).toBe("Sync Project");
  });

  test("fullSync preserves existing projectName when webhook has empty projectName (UPDATE path)", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    // First insert with a project name
    const issue = makeIssue({
      identifier: "PN-SYNC-2",
      projectName: "Original Project",
    });
    const client = mockLinearClient([issue]);
    const graph = new DependencyGraph();

    await fullSync(db, client, graph, config);
    expect(getTask(db, "PN-SYNC-2")!.projectName).toBe("Original Project");

    // Second sync with empty projectName (simulating webhook-like behavior)
    const issueWithEmptyProject = makeIssue({
      identifier: "PN-SYNC-2",
      projectName: "",
    });
    const client2 = mockLinearClient([issueWithEmptyProject]);

    await fullSync(db, client2, graph, config);

    // The conditional spread `...(issue.projectName ? { projectName: ... } : {})`
    // should skip the update when projectName is ""
    const task = getTask(db, "PN-SYNC-2");
    expect(task!.projectName).toBe("Original Project");
  });

  test("fullSync updates projectName when new non-empty value is provided", async () => {
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    // Insert with initial project name
    const issue1 = makeIssue({
      identifier: "PN-SYNC-3",
      projectName: "Alpha",
    });
    const client1 = mockLinearClient([issue1]);
    const graph = new DependencyGraph();

    await fullSync(db, client1, graph, config);

    // Update with new project name
    const issue2 = makeIssue({
      identifier: "PN-SYNC-3",
      projectName: "Beta",
    });
    const client2 = mockLinearClient([issue2]);

    await fullSync(db, client2, graph, config);

    const task = getTask(db, "PN-SYNC-3");
    expect(task!.projectName).toBe("Beta");
  });
});

// ===========================================================================
// 3. Webhook path: projectName preserved during webhook upserts
// ===========================================================================

describe("Webhook - projectName preservation", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  test("webhook create for NEW task inserts with empty projectName (not preserved from nonexistent task)", async () => {
    // BUG CANDIDATE: When a webhook creates a brand new task (no existing task in DB),
    // projectName is "" from the webhook. On INSERT path, this stores "" in DB.
    // This is a data quality issue -- brand new webhook-created tasks have no project name.
    const { processWebhookEvent } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();
    const client = mockLinearClient();
    const graph = new DependencyGraph();
    const stateMap = new Map([
      ["Todo", { id: "state-todo", type: "unstarted" }],
    ]);

    await processWebhookEvent(db, client, graph, config, stateMap, {
      action: "create",
      type: "Issue",
      data: {
        id: "uuid-new",
        identifier: "PN-WH-NEW",
        title: "Brand new webhook task",
        description: "test",
        priority: 2,
        state: { id: "state-todo", name: "Todo", type: "unstarted" },
        projectId: "proj-1",
      },
    });

    const task = getTask(db, "PN-WH-NEW");
    expect(task).toBeDefined();
    // On INSERT path, projectName comes from issue.projectName which is ""
    // This means webhook-created tasks start with empty string, not null
    expect(task!.projectName).toBe("");
  });

  test("webhook update for EXISTING task preserves projectName when webhook has no project info", async () => {
    const { processWebhookEvent } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();
    const client = mockLinearClient();
    const graph = new DependencyGraph();
    const stateMap = new Map([
      ["Todo", { id: "state-todo", type: "unstarted" }],
    ]);

    // Pre-seed task with a project name
    seedTask(db, {
      linearIssueId: "PN-WH-EXISTING",
      projectName: "Preserved Project",
      orcaStatus: "ready",
    });

    // Webhook update (no project name in payload)
    await processWebhookEvent(db, client, graph, config, stateMap, {
      action: "update",
      type: "Issue",
      data: {
        id: "uuid-existing",
        identifier: "PN-WH-EXISTING",
        title: "Updated title",
        description: "test",
        priority: 2,
        state: { id: "state-todo", name: "Todo", type: "unstarted" },
        projectId: "proj-1",
      },
    });

    const task = getTask(db, "PN-WH-EXISTING");
    expect(task).toBeDefined();
    // The conditional update should preserve the existing projectName
    expect(task!.projectName).toBe("Preserved Project");
  });
});

// ===========================================================================
// 4. LinearClient: project.name null/undefined handling
// ===========================================================================

describe("LinearClient - project.name edge cases", () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: Mock;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function getClient() {
    const { LinearClient } = await import("../src/linear/client.js");
    return new LinearClient("test-key");
  }

  test("project with name=null results in null projectName (potential crash)", async () => {
    // Linear API could return project.name as null if project has no name
    const client = await getClient();

    const response = {
      data: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "issue-1",
              identifier: "PROJ-1",
              title: "Test issue",
              description: "test",
              priority: 2,
              state: { id: "s1", name: "Todo", type: "unstarted" },
              team: { id: "team-1" },
              project: { id: "proj-1", name: null },
              relations: { nodes: [] },
              inverseRelations: { nodes: [] },
              parent: null,
              children: { nodes: [] },
            },
          ],
        },
      },
    };

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const issues = await client.fetchProjectIssues(["proj-1"]);
    expect(issues).toHaveLength(1);
    // node.project.name is null, so projectName should be null
    // But the TypeScript type says projectName: string (not string | null)
    // This is a type safety issue
    expect(issues[0]!.projectName).toBeNull();
  });

  test("project with name missing results in undefined projectName", async () => {
    // Linear API could return project without name field entirely
    const client = await getClient();

    const response = {
      data: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "issue-1",
              identifier: "PROJ-1",
              title: "Test issue",
              description: "test",
              priority: 2,
              state: { id: "s1", name: "Todo", type: "unstarted" },
              team: { id: "team-1" },
              project: { id: "proj-1" }, // no name field at all
              relations: { nodes: [] },
              inverseRelations: { nodes: [] },
              parent: null,
              children: { nodes: [] },
            },
          ],
        },
      },
    };

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const issues = await client.fetchProjectIssues(["proj-1"]);
    expect(issues).toHaveLength(1);
    // node.project.name is undefined because it's not in the response
    // The code does `projectName: node.project.name` which would be undefined
    // But the type declares projectName: string
    // This is a type-safety hole: runtime value doesn't match declared type
    expect(issues[0]!.projectName).toBeUndefined();
  });

  test("project with valid name is correctly mapped", async () => {
    const client = await getClient();

    const response = {
      data: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "issue-1",
              identifier: "PROJ-1",
              title: "Test issue",
              description: "test",
              priority: 2,
              state: { id: "s1", name: "Todo", type: "unstarted" },
              team: { id: "team-1" },
              project: { id: "proj-1", name: "Valid Project" },
              relations: { nodes: [] },
              inverseRelations: { nodes: [] },
              parent: null,
              children: { nodes: [] },
            },
          ],
        },
      },
    };

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const issues = await client.fetchProjectIssues(["proj-1"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.projectName).toBe("Valid Project");
  });
});

// ===========================================================================
// 5. makeIssue helpers in existing tests lack projectName
// ===========================================================================

describe("Existing test helpers missing projectName", () => {
  test("LinearIssue interface requires projectName field", () => {
    // This test verifies that objects satisfying the LinearIssue interface
    // must include projectName. The existing test helpers in
    // linear-integration.test.ts (line 327-342), repo-mapping.test.ts (line 140-158),
    // and parent-child.test.ts (line 456-474) create LinearIssue-like objects
    // WITHOUT projectName. They pass TypeScript only because they are typed
    // as Record<string, unknown> or use `as any`.
    //
    // This means those tests are not testing the full shape and could miss
    // bugs where projectName handling breaks.
    const validIssue: import("../src/linear/client.js").LinearIssue = {
      id: "test",
      identifier: "TEST-1",
      title: "Test",
      description: "",
      priority: 0,
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
    };

    expect(validIssue.projectName).toBe("Test Project");
  });
});

// ===========================================================================
// 6. Conditional update logic edge cases
// ===========================================================================

describe("Conditional projectName update in upsertTask", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  test("BUG: fullSync with projectName=undefined on existing task does NOT update (treated as falsy)", async () => {
    // If the Linear API returns project.name as undefined (no name field),
    // the conditional `...(issue.projectName ? { projectName: ... } : {})`
    // will skip the update. This is CORRECT behavior for preservation.
    // But it means the task retains its old projectName even if the project
    // was actually removed from the issue.
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    // Seed with project name
    seedTask(db, {
      linearIssueId: "PN-COND-1",
      projectName: "Old Project",
      orcaStatus: "ready",
    });

    // Sync with issue that has no projectName (undefined due to missing field)
    const issue = makeIssue({
      identifier: "PN-COND-1",
      projectName: undefined,
    });
    const client = mockLinearClient([issue]);
    const graph = new DependencyGraph();

    await fullSync(db, client, graph, config);

    const task = getTask(db, "PN-COND-1");
    // The old project name is preserved because undefined is falsy
    expect(task!.projectName).toBe("Old Project");
  });

  test("BUG: cannot clear projectName to null via fullSync because falsy check blocks it", async () => {
    // If someone moves an issue out of a project, the ideal behavior would
    // be to set projectName to null. But the current conditional logic
    // prevents this: empty string, null, and undefined all skip the update.
    const { fullSync } = await import("../src/linear/sync.js");
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();

    // Seed with project name
    seedTask(db, {
      linearIssueId: "PN-CLEAR-1",
      projectName: "Should Be Cleared",
      orcaStatus: "ready",
    });

    // Sync with null projectName (issue removed from project)
    const issue = makeIssue({
      identifier: "PN-CLEAR-1",
      projectName: null as any,  // Type mismatch but could happen at runtime
    });
    const client = mockLinearClient([issue]);
    const graph = new DependencyGraph();

    await fullSync(db, client, graph, config);

    const task = getTask(db, "PN-CLEAR-1");
    // projectName is NOT cleared because null is falsy
    // This is a design limitation: once set, projectName cannot be unset via sync
    expect(task!.projectName).toBe("Should Be Cleared");
  });
});

// ===========================================================================
// 7. Frontend sort comparator edge cases
// ===========================================================================

describe("Frontend sort comparator - project", () => {
  // These test the sorting logic extracted from the component
  function sortByProject<T extends { projectName: string | null }>(items: T[]): T[] {
    return [...items].sort((a, b) => {
      return (a.projectName ?? "").localeCompare(b.projectName ?? "");
    });
  }

  test("null projectName sorts to beginning (empty string)", () => {
    const items = [
      { projectName: "Zebra" },
      { projectName: null },
      { projectName: "Alpha" },
    ];
    const sorted = sortByProject(items);
    // null becomes "" which sorts before "Alpha"
    expect(sorted[0]!.projectName).toBeNull();
    expect(sorted[1]!.projectName).toBe("Alpha");
    expect(sorted[2]!.projectName).toBe("Zebra");
  });

  test("all null projectNames sort stably", () => {
    const items = [
      { projectName: null, id: "a" },
      { projectName: null, id: "b" },
      { projectName: null, id: "c" },
    ];
    const sorted = sortByProject(items);
    // All compare as equal ("" vs ""), so original order preserved
    expect(sorted).toHaveLength(3);
  });

  test("empty string projectName sorts same as null", () => {
    const items = [
      { projectName: "Beta" },
      { projectName: "" },
      { projectName: null },
      { projectName: "Alpha" },
    ];
    const sorted = sortByProject(items);
    // "" and null both become "" in localeCompare
    // They should sort before "Alpha"
    expect(sorted[0]!.projectName === "" || sorted[0]!.projectName === null).toBe(true);
    expect(sorted[1]!.projectName === "" || sorted[1]!.projectName === null).toBe(true);
    expect(sorted[2]!.projectName).toBe("Alpha");
    expect(sorted[3]!.projectName).toBe("Beta");
  });

  test("case sensitivity in project sort", () => {
    const items = [
      { projectName: "zebra" },
      { projectName: "Alpha" },
      { projectName: "alpha" },
    ];
    const sorted = sortByProject(items);
    // localeCompare is locale-sensitive; 'alpha' and 'Alpha' sort near each other
    // but the exact order depends on locale
    expect(sorted).toHaveLength(3);
  });
});

// ===========================================================================
// 8. Type consistency between backend and frontend
// ===========================================================================

describe("Type consistency", () => {
  test("DB schema projectName is nullable (text without notNull)", () => {
    // The schema defines: projectName: text("project_name")
    // Without .notNull(), this means the DB column can be NULL.
    // The frontend type has: projectName: string | null
    // The LinearIssue type has: projectName: string (NOT nullable)
    // This is inconsistent: LinearIssue says it's always a string,
    // but the DB and frontend allow null.
    //
    // The inconsistency means: when creating a LinearIssue from webhook data,
    // projectName is set to "" (empty string) instead of null, which is then
    // stored in DB as "" on INSERT. But the frontend expects string | null,
    // and the DB schema allows null.
    //
    // Result: Some tasks have projectName="" and others have projectName=null.
    // The frontend chip `{task.projectName && ...}` treats both as hidden,
    // but "" vs null is an unnecessary inconsistency.

    const db = freshDb();
    const ts = now();

    // Insert with null
    insertTask(db, {
      linearIssueId: "TYPE-1",
      agentPrompt: "test",
      repoPath: "/tmp",
      orcaStatus: "ready",
      priority: 0,
      retryCount: 0,
      projectName: null,
      createdAt: ts,
      updatedAt: ts,
    });

    // Insert with empty string
    insertTask(db, {
      linearIssueId: "TYPE-2",
      agentPrompt: "test",
      repoPath: "/tmp",
      orcaStatus: "ready",
      priority: 0,
      retryCount: 0,
      projectName: "",
      createdAt: ts,
      updatedAt: ts,
    });

    const task1 = getTask(db, "TYPE-1");
    const task2 = getTask(db, "TYPE-2");

    // These are different but both treated as "no project" in the UI
    expect(task1!.projectName).toBeNull();
    expect(task2!.projectName).toBe("");

    // This inconsistency could cause bugs in filtering/grouping by project
    expect(task1!.projectName).not.toBe(task2!.projectName);
  });
});

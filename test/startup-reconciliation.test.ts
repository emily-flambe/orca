// ---------------------------------------------------------------------------
// Startup reconciliation tests (EMI-223)
// ---------------------------------------------------------------------------
//
// Tests for the reconciliation loop in src/cli/index.ts that fires write-backs
// for failed tasks whose Linear status is still "In Progress" or "In Review"
// after a crash/restart.
//
// These tests replicate the reconciliation loop logic to verify filtering and
// matching behavior without spinning up the full CLI.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import { insertTask, getAllTasks } from "../src/db/queries.js";

vi.mock("../src/session-handles.js", () => ({
  activeHandles: new Map(),
}));

vi.mock("../src/runner/index.js", () => ({
  killSession: vi.fn().mockResolvedValue({}),
  spawnSession: vi.fn(),
}));

vi.mock("../src/github/index.js", () => ({
  closePrsForCanceledTask: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): OrcaDb {
  return createDb(":memory:");
}

function seedTask(
  db: OrcaDb,
  overrides: {
    linearIssueId?: string;
    orcaStatus?: "ready" | "running" | "failed" | "done" | "in_review";
  } = {},
): string {
  const id = overrides.linearIssueId ?? `TEST-${Date.now().toString(36)}`;
  const ts = new Date().toISOString();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: "do something",
    repoPath: "/tmp/fake-repo",
    orcaStatus: overrides.orcaStatus ?? "ready",
    priority: 0,
    retryCount: 0,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

function makeLinearIssue(
  identifier: string,
  id: string,
  stateName: string,
): import("../src/linear/client.js").LinearIssue {
  return {
    id,
    identifier,
    title: `Issue ${identifier}`,
    description: "",
    priority: 0,
    state: { id: "state-id", name: stateName, type: "started" },
    teamId: "team-1",
    projectId: "proj-1",
    relations: [],
    inverseRelations: [],
    parentId: null,
    parentTitle: null,
    parentDescription: null,
    projectName: "Test Project",
    childIds: [],
  };
}

// Simulates the reconciliation loop from src/cli/index.ts.
// Returns the count of tasks that would be reconciled.
function runReconciliationLoop(
  db: OrcaDb,
  syncedIssues: import("../src/linear/client.js").LinearIssue[],
  writeBackMock: ReturnType<typeof vi.fn>,
  createCommentMock: ReturnType<typeof vi.fn>,
): number {
  const activeLinearStates = new Set(["In Progress", "In Review"]);
  const failedTasks = getAllTasks(db).filter((t) => t.orcaStatus === "failed");
  const syncedIssueMap = new Map(
    syncedIssues.map((issue) => [issue.identifier, issue]),
  );

  let reconciled = 0;
  for (const task of failedTasks) {
    const linearIssue = syncedIssueMap.get(task.linearIssueId);
    if (!linearIssue || !activeLinearStates.has(linearIssue.state.name)) {
      continue;
    }
    writeBackMock(task.linearIssueId, "failed_permanent");
    createCommentMock(task.linearIssueId); // identifier, not UUID
    reconciled++;
  }
  return reconciled;
}

// ---------------------------------------------------------------------------

describe("Reconciliation: filtering by Linear state", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("failed task with Linear 'In Progress' IS reconciled", () => {
    const db = freshDb();
    seedTask(db, { linearIssueId: "PROJ-1", orcaStatus: "failed" });

    const syncedIssues = [makeLinearIssue("PROJ-1", "uuid-1", "In Progress")];
    const writeBackMock = vi.fn().mockResolvedValue(undefined);
    const createCommentMock = vi.fn().mockResolvedValue(undefined);

    const count = runReconciliationLoop(
      db,
      syncedIssues,
      writeBackMock,
      createCommentMock,
    );

    expect(count).toBe(1);
    expect(writeBackMock).toHaveBeenCalledWith("PROJ-1", "failed_permanent");
    expect(createCommentMock).toHaveBeenCalledWith("PROJ-1");
  });

  test("failed task with Linear 'In Review' IS reconciled", () => {
    const db = freshDb();
    seedTask(db, { linearIssueId: "PROJ-2", orcaStatus: "failed" });

    const syncedIssues = [makeLinearIssue("PROJ-2", "uuid-2", "In Review")];
    const writeBackMock = vi.fn().mockResolvedValue(undefined);
    const createCommentMock = vi.fn().mockResolvedValue(undefined);

    const count = runReconciliationLoop(
      db,
      syncedIssues,
      writeBackMock,
      createCommentMock,
    );

    expect(count).toBe(1);
    expect(writeBackMock).toHaveBeenCalledWith("PROJ-2", "failed_permanent");
  });

  test("failed task with Linear 'Canceled' is NOT reconciled", () => {
    const db = freshDb();
    seedTask(db, { linearIssueId: "PROJ-3", orcaStatus: "failed" });

    const syncedIssues = [makeLinearIssue("PROJ-3", "uuid-3", "Canceled")];
    const writeBackMock = vi.fn();
    const createCommentMock = vi.fn();

    const count = runReconciliationLoop(
      db,
      syncedIssues,
      writeBackMock,
      createCommentMock,
    );

    expect(count).toBe(0);
    expect(writeBackMock).not.toHaveBeenCalled();
  });

  test("failed task with Linear 'Done' is NOT reconciled", () => {
    const db = freshDb();
    seedTask(db, { linearIssueId: "PROJ-4", orcaStatus: "failed" });

    const syncedIssues = [makeLinearIssue("PROJ-4", "uuid-4", "Done")];
    const writeBackMock = vi.fn();
    const createCommentMock = vi.fn();

    const count = runReconciliationLoop(
      db,
      syncedIssues,
      writeBackMock,
      createCommentMock,
    );

    expect(count).toBe(0);
    expect(writeBackMock).not.toHaveBeenCalled();
  });

  test("failed task with Linear 'Todo' is NOT reconciled", () => {
    const db = freshDb();
    seedTask(db, { linearIssueId: "PROJ-5", orcaStatus: "failed" });

    const syncedIssues = [makeLinearIssue("PROJ-5", "uuid-5", "Todo")];
    const writeBackMock = vi.fn();
    const createCommentMock = vi.fn();

    const count = runReconciliationLoop(
      db,
      syncedIssues,
      writeBackMock,
      createCommentMock,
    );

    expect(count).toBe(0);
    expect(writeBackMock).not.toHaveBeenCalled();
  });

  test("non-failed tasks are not reconciled even if Linear shows active state", () => {
    const db = freshDb();
    seedTask(db, { linearIssueId: "PROJ-6", orcaStatus: "running" });
    seedTask(db, { linearIssueId: "PROJ-7", orcaStatus: "done" });
    seedTask(db, { linearIssueId: "PROJ-8", orcaStatus: "ready" });

    const syncedIssues = [
      makeLinearIssue("PROJ-6", "uuid-6", "In Progress"),
      makeLinearIssue("PROJ-7", "uuid-7", "In Progress"),
      makeLinearIssue("PROJ-8", "uuid-8", "In Progress"),
    ];
    const writeBackMock = vi.fn();
    const createCommentMock = vi.fn();

    const count = runReconciliationLoop(
      db,
      syncedIssues,
      writeBackMock,
      createCommentMock,
    );

    expect(count).toBe(0);
    expect(writeBackMock).not.toHaveBeenCalled();
  });

  test("task not in any synced project is silently skipped", () => {
    const db = freshDb();
    seedTask(db, { linearIssueId: "ORCA-xyz123", orcaStatus: "failed" });

    // syncedIssues contains a different task, not ORCA-xyz123
    const syncedIssues = [makeLinearIssue("PROJ-1", "uuid-1", "In Progress")];
    const writeBackMock = vi.fn();
    const createCommentMock = vi.fn();

    const count = runReconciliationLoop(
      db,
      syncedIssues,
      writeBackMock,
      createCommentMock,
    );

    expect(count).toBe(0);
    expect(writeBackMock).not.toHaveBeenCalled();
  });

  test("when syncedIssues is empty, all failed tasks are skipped", () => {
    const db = freshDb();
    seedTask(db, { linearIssueId: "PROJ-10", orcaStatus: "failed" });
    seedTask(db, { linearIssueId: "PROJ-11", orcaStatus: "failed" });

    const writeBackMock = vi.fn();
    const createCommentMock = vi.fn();

    const count = runReconciliationLoop(
      db,
      [],
      writeBackMock,
      createCommentMock,
    );

    expect(count).toBe(0);
    expect(writeBackMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("Reconciliation: multiple tasks", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("only the tasks with active Linear states are reconciled", () => {
    const db = freshDb();
    seedTask(db, { linearIssueId: "PROJ-20", orcaStatus: "failed" });
    seedTask(db, { linearIssueId: "PROJ-21", orcaStatus: "failed" });
    seedTask(db, { linearIssueId: "PROJ-22", orcaStatus: "failed" });
    seedTask(db, { linearIssueId: "PROJ-23", orcaStatus: "failed" }); // already Canceled

    const syncedIssues = [
      makeLinearIssue("PROJ-20", "uuid-20", "In Progress"),
      makeLinearIssue("PROJ-21", "uuid-21", "In Review"),
      makeLinearIssue("PROJ-22", "uuid-22", "In Progress"),
      makeLinearIssue("PROJ-23", "uuid-23", "Canceled"),
    ];
    const writeBackMock = vi.fn().mockResolvedValue(undefined);
    const createCommentMock = vi.fn().mockResolvedValue(undefined);

    const count = runReconciliationLoop(
      db,
      syncedIssues,
      writeBackMock,
      createCommentMock,
    );

    expect(count).toBe(3);
    expect(writeBackMock).toHaveBeenCalledTimes(3);
    expect(writeBackMock).toHaveBeenCalledWith("PROJ-20", "failed_permanent");
    expect(writeBackMock).toHaveBeenCalledWith("PROJ-21", "failed_permanent");
    expect(writeBackMock).toHaveBeenCalledWith("PROJ-22", "failed_permanent");
    expect(writeBackMock).not.toHaveBeenCalledWith(
      "PROJ-23",
      "failed_permanent",
    );
  });

  test("createComment is called with identifier (not UUID), consistent with rest of codebase", () => {
    const db = freshDb();
    seedTask(db, { linearIssueId: "PROJ-30", orcaStatus: "failed" });

    const IDENTIFIER = "PROJ-30";
    const UUID = "uuid-abc-30";
    const syncedIssues = [makeLinearIssue(IDENTIFIER, UUID, "In Progress")];
    const writeBackMock = vi.fn().mockResolvedValue(undefined);
    const createCommentMock = vi.fn().mockResolvedValue(undefined);

    runReconciliationLoop(db, syncedIssues, writeBackMock, createCommentMock);

    // createComment should receive the identifier (e.g. "PROJ-30"), not the UUID
    expect(createCommentMock).toHaveBeenCalledWith(IDENTIFIER);
    expect(createCommentMock).not.toHaveBeenCalledWith(UUID);
  });
});

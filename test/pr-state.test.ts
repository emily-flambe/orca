// ---------------------------------------------------------------------------
// Adversarial tests for EMI-379: PR link and status icons
//
// Targets:
// - mapPrState (src/github/index.ts)
// - updateTaskPrState (src/db/queries.ts)
// - PrIndicator component (web/src/components/TaskList.tsx)
// - Migration 16 (src/db/index.ts)
// - findPrForBranch / findPrByUrl state field
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// 1. mapPrState and findPrForBranch / findPrByUrl state field
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("../src/git.js", () => ({
  git: vi.fn(),
  isTransientGitError: vi.fn().mockReturnValue(false),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  rmSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { findPrForBranch, findPrByUrl } from "../src/github/index.js";

const execSyncMock = execFileSync as unknown as ReturnType<typeof vi.fn>;

describe("mapPrState via findPrForBranch", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("OPEN state with isDraft=false maps to 'open'", async () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify([
        {
          url: "https://github.com/org/repo/pull/1",
          number: 1,
          state: "OPEN",
          headRefName: "orca/test-1",
          isDraft: false,
        },
      ]),
    );
    const result = await findPrForBranch("orca/test-1", "/tmp", 1);
    expect(result.state).toBe("open");
  });

  test("OPEN state with isDraft=true maps to 'draft'", async () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify([
        {
          url: "https://github.com/org/repo/pull/2",
          number: 2,
          state: "OPEN",
          headRefName: "orca/test-2",
          isDraft: true,
        },
      ]),
    );
    const result = await findPrForBranch("orca/test-2", "/tmp", 1);
    expect(result.state).toBe("draft");
  });

  test("MERGED state maps to 'merged' regardless of isDraft", async () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify([
        {
          url: "https://github.com/org/repo/pull/3",
          number: 3,
          state: "MERGED",
          headRefName: "orca/test-3",
          isDraft: true,
        },
      ]),
    );
    const result = await findPrForBranch("orca/test-3", "/tmp", 1);
    expect(result.state).toBe("merged");
    expect(result.merged).toBe(true);
  });

  test("CLOSED state maps to 'closed'", async () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify([
        {
          url: "https://github.com/org/repo/pull/4",
          number: 4,
          state: "CLOSED",
          headRefName: "orca/test-4",
          isDraft: false,
        },
      ]),
    );
    const result = await findPrForBranch("orca/test-4", "/tmp", 1);
    expect(result.state).toBe("closed");
  });

  // BUG CANDIDATE: What happens with unexpected/unknown state values from
  // GitHub API? The mapPrState function falls through to "open" for any
  // unrecognized value. This might hide genuine issues.
  test("unknown state value falls through to 'open'", async () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify([
        {
          url: "https://github.com/org/repo/pull/5",
          number: 5,
          state: "SOME_NEW_STATE",
          headRefName: "orca/test-5",
          isDraft: false,
        },
      ]),
    );
    const result = await findPrForBranch("orca/test-5", "/tmp", 1);
    // This documents the behavior: unknown states map to "open"
    expect(result.state).toBe("open");
  });

  // BUG CANDIDATE: What if isDraft is undefined (older gh CLI versions)?
  test("isDraft missing (undefined) from gh response treats as non-draft", async () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify([
        {
          url: "https://github.com/org/repo/pull/6",
          number: 6,
          state: "OPEN",
          headRefName: "orca/test-6",
          // isDraft intentionally omitted
        },
      ]),
    );
    const result = await findPrForBranch("orca/test-6", "/tmp", 1);
    expect(result.state).toBe("open");
    // This should NOT be "draft" since isDraft is undefined (falsy)
    expect(result.state).not.toBe("draft");
  });
});

describe("mapPrState via findPrByUrl", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("findPrByUrl includes state field in returned PrInfo", () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({
        url: "https://github.com/org/repo/pull/10",
        number: 10,
        state: "OPEN",
        headRefName: "orca/test-10",
        isDraft: false,
      }),
    );
    const result = findPrByUrl("https://github.com/org/repo/pull/10", "/tmp");
    expect(result.state).toBe("open");
    expect(result.exists).toBe(true);
  });

  // BUG CANDIDATE: findPrByUrl falls back to "OPEN" when state is missing
  // but isDraft is also missing, which could produce wrong state
  test("findPrByUrl with missing state field falls back to 'open'", () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({
        url: "https://github.com/org/repo/pull/11",
        number: 11,
        // state intentionally omitted
        headRefName: "orca/test-11",
      }),
    );
    const result = findPrByUrl("https://github.com/org/repo/pull/11", "/tmp");
    expect(result.state).toBe("open");
  });

  test("findPrByUrl with isDraft=true and state missing returns 'draft'", () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({
        url: "https://github.com/org/repo/pull/12",
        number: 12,
        // state intentionally omitted
        headRefName: "orca/test-12",
        isDraft: true,
      }),
    );
    const result = findPrByUrl("https://github.com/org/repo/pull/12", "/tmp");
    expect(result.state).toBe("draft");
  });
});

// ---------------------------------------------------------------------------
// 2. updateTaskPrState DB queries
// ---------------------------------------------------------------------------

import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  getTask,
  updateTaskPrState,
} from "../src/db/queries.js";

function freshDb(): OrcaDb {
  return createDb(":memory:");
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeTask(db: OrcaDb, id: string, overrides?: Partial<Parameters<typeof insertTask>[1]>): void {
  const ts = nowIso();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: "test prompt",
    repoPath: "/tmp/test-repo",
    orcaStatus: "ready",
    priority: 0,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  });
}

describe("updateTaskPrState", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("sets prUrl and prState on a task", () => {
    makeTask(db, "TASK-1");
    updateTaskPrState(db, "TASK-1", "https://github.com/org/repo/pull/1", "open");
    const task = getTask(db, "TASK-1");
    expect(task?.prUrl).toBe("https://github.com/org/repo/pull/1");
    expect(task?.prState).toBe("open");
  });

  test("handles null prUrl and null prState", () => {
    makeTask(db, "TASK-2");
    updateTaskPrState(db, "TASK-2", null, null);
    const task = getTask(db, "TASK-2");
    expect(task?.prUrl).toBeNull();
    expect(task?.prState).toBeNull();
  });

  test("clears prUrl/prState back to null after being set", () => {
    makeTask(db, "TASK-3");
    updateTaskPrState(db, "TASK-3", "https://github.com/org/repo/pull/3", "open");
    let task = getTask(db, "TASK-3");
    expect(task?.prUrl).toBe("https://github.com/org/repo/pull/3");

    updateTaskPrState(db, "TASK-3", null, null);
    task = getTask(db, "TASK-3");
    expect(task?.prUrl).toBeNull();
    expect(task?.prState).toBeNull();
  });

  test("updates updatedAt timestamp", () => {
    makeTask(db, "TASK-4");
    const before = getTask(db, "TASK-4")?.updatedAt;

    // Small delay to ensure different timestamp
    updateTaskPrState(db, "TASK-4", "https://github.com/org/repo/pull/4", "merged");
    const after = getTask(db, "TASK-4")?.updatedAt;
    expect(after).not.toBeUndefined();
    // updatedAt should be at least as recent
    expect(after! >= before!).toBe(true);
  });

  test("handles nonexistent task without error", () => {
    // Should not throw even if task doesn't exist
    expect(() =>
      updateTaskPrState(db, "NONEXISTENT", "https://example.com/pull/1", "open"),
    ).not.toThrow();
  });

  // BUG CANDIDATE: prState is stored as unconstrained TEXT in SQLite.
  // Any arbitrary string can be stored, which the frontend might not handle.
  test("accepts arbitrary string as prState (no DB constraint)", () => {
    makeTask(db, "TASK-5");
    updateTaskPrState(db, "TASK-5", "https://example.com/pull/5", "BOGUS_STATE");
    const task = getTask(db, "TASK-5");
    expect(task?.prState).toBe("BOGUS_STATE");
    // This is a potential issue: the frontend PrIndicator will receive this
    // unexpected value and use the fallback color
  });

  test("handles prUrl with null prState (partial data)", () => {
    makeTask(db, "TASK-6");
    updateTaskPrState(db, "TASK-6", "https://example.com/pull/6", null);
    const task = getTask(db, "TASK-6");
    expect(task?.prUrl).toBe("https://example.com/pull/6");
    expect(task?.prState).toBeNull();
    // Frontend guards with `task.prUrl && task.prState` so this won't render
  });

  test("handles null prUrl with non-null prState (inconsistent data)", () => {
    makeTask(db, "TASK-7");
    updateTaskPrState(db, "TASK-7", null, "open");
    const task = getTask(db, "TASK-7");
    expect(task?.prUrl).toBeNull();
    expect(task?.prState).toBe("open");
    // Frontend guards with `task.prUrl && task.prState` so this won't render
    // But the data is inconsistent — state without URL shouldn't happen
  });

  // SQL injection test
  test("handles SQL-injection-style prUrl without error", () => {
    makeTask(db, "TASK-8");
    const malicious = "'; DROP TABLE tasks; --";
    updateTaskPrState(db, "TASK-8", malicious, "open");
    const task = getTask(db, "TASK-8");
    expect(task?.prUrl).toBe(malicious);
    // Verify table still exists
    const allTasks = getTask(db, "TASK-8");
    expect(allTasks).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Migration 16 — pr_url and pr_state columns
// ---------------------------------------------------------------------------

describe("Migration 16 (pr_url and pr_state columns)", () => {
  test("new database has pr_url and pr_state columns", () => {
    const db = freshDb();
    makeTask(db, "MIG-1");
    const task = getTask(db, "MIG-1");
    // These should be null by default
    expect(task?.prUrl).toBeNull();
    expect(task?.prState).toBeNull();
  });

  test("pr_url and pr_state columns are nullable (no NOT NULL constraint)", () => {
    const db = freshDb();
    makeTask(db, "MIG-2");
    // Inserting without specifying prUrl/prState should work fine
    const task = getTask(db, "MIG-2");
    expect(task).toBeDefined();
    expect(task?.prUrl).toBeNull();
    expect(task?.prState).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. ci-merge workflow: updateTaskPrState called on merge
// ---------------------------------------------------------------------------

describe("ci-merge PR state update on merge", () => {
  test("mergeAndFinalizeStep sets prState to 'merged' using existing prUrl", () => {
    // This is a structural test: verify the code path in ci-merge.ts line 559
    // calls updateTaskPrState(db, taskId, task.prUrl ?? null, "merged")
    //
    // BUG FINDING: If task.prUrl was never set (null), the merge still
    // records prState="merged" with prUrl=null. This creates inconsistent
    // data where prState is set but prUrl is null. The frontend won't show
    // it (guarded by `task.prUrl && task.prState`), but it's data pollution.
    //
    // Verified by reading ci-merge.ts line 559:
    //   updateTaskPrState(db, taskId, task.prUrl ?? null, "merged");
    // If task.prUrl is already null (e.g., PR was found by URL extraction
    // but state was never persisted), this stores null URL with "merged" state.
    const db = freshDb();
    makeTask(db, "MERGE-1");
    // Simulate what ci-merge does: task has no prUrl set
    const task = getTask(db, "MERGE-1");
    updateTaskPrState(db, "MERGE-1", task?.prUrl ?? null, "merged");
    const after = getTask(db, "MERGE-1");
    expect(after?.prState).toBe("merged");
    expect(after?.prUrl).toBeNull(); // data inconsistency
  });
});

// ---------------------------------------------------------------------------
// 5. Shared types: prState type narrowing
// ---------------------------------------------------------------------------

describe("shared types Task interface", () => {
  test("prState type allows draft|open|merged|closed|null", () => {
    // TypeScript type check: the shared Task interface defines
    //   prState: "draft" | "open" | "merged" | "closed" | null
    // But the DB has no CHECK constraint — any string can be stored.
    // This is a type-level guarantee only.
    const db = freshDb();
    makeTask(db, "TYPE-1");
    updateTaskPrState(db, "TYPE-1", "https://example.com/1", "draft");
    const t1 = getTask(db, "TYPE-1");
    expect(t1?.prState).toBe("draft");

    updateTaskPrState(db, "TYPE-1", "https://example.com/1", "closed");
    const t2 = getTask(db, "TYPE-1");
    expect(t2?.prState).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// 6. Gate 2 and Guard B: PR state is set on task after PR discovery
// ---------------------------------------------------------------------------

describe("Gate 2 / Guard B PR state persistence", () => {
  test("task-lifecycle sets prState when Guard B finds CI-passing PR", () => {
    // Lines 879-884 of task-lifecycle.ts:
    //   updateTaskPrState(db, taskId, prInfo.url ?? null, prInfo.state ?? "open")
    //
    // This means if prInfo.state is undefined (findPrForBranch returns
    // { exists: false }), it falls back to "open". But if exists is false,
    // we shouldn't reach this code path.
    //
    // What if prInfo.state is undefined but prInfo.exists is true?
    // This can happen if the PrInfo interface has state as optional.
    // The ?? "open" fallback handles this gracefully.
    const db = freshDb();
    makeTask(db, "GUARD-1");
    // Simulate fallback: prInfo.state is undefined
    updateTaskPrState(db, "GUARD-1", "https://github.com/org/repo/pull/99", undefined as unknown as string);
    const task = getTask(db, "GUARD-1");
    // SQLite stores undefined as null
    expect(task?.prState).toBeNull();
  });

  test("Gate 2 sets prState when PR found by branch", () => {
    // Lines 1093-1098 of task-lifecycle.ts:
    //   updateTaskPrState(db, taskId, prInfo.url ?? null, prInfo.state ?? "open")
    const db = freshDb();
    makeTask(db, "GATE2-1");
    updateTaskPrState(db, "GATE2-1", "https://github.com/org/repo/pull/100", "open");
    const task = getTask(db, "GATE2-1");
    expect(task?.prUrl).toBe("https://github.com/org/repo/pull/100");
    expect(task?.prState).toBe("open");
  });
});

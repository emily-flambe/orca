/**
 * EMI-379 PR Info Feature — adversarial tests.
 *
 * Tests the prUrl/prState feature for edge cases, type mismatches,
 * missing data scenarios, and DB migration correctness.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { tasks } from "../src/db/schema.js";
import type { Task } from "../src/shared/types.js";

// ---------------------------------------------------------------------------
// Mock child_process for gh CLI tests
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

// ---------------------------------------------------------------------------
// Helper: create in-memory DB with the tasks table (including pr_url, pr_state)
// ---------------------------------------------------------------------------
function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE tasks (
      linear_issue_id TEXT PRIMARY KEY,
      agent_prompt TEXT NOT NULL DEFAULT '',
      repo_path TEXT NOT NULL DEFAULT '/tmp/repo',
      orca_status TEXT NOT NULL DEFAULT 'backlog',
      priority INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      pr_branch_name TEXT,
      review_cycle_count INTEGER NOT NULL DEFAULT 0,
      merge_commit_sha TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      pr_state TEXT,
      deploy_started_at TEXT,
      ci_started_at TEXT,
      fix_reason TEXT,
      merge_attempt_count INTEGER NOT NULL DEFAULT 0,
      stale_session_retry_count INTEGER NOT NULL DEFAULT 0,
      done_at TEXT,
      parent_identifier TEXT,
      is_parent INTEGER NOT NULL DEFAULT 0,
      project_name TEXT,
      task_type TEXT NOT NULL DEFAULT 'linear',
      cron_schedule_id INTEGER,
      agent_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const db = drizzle(sqlite, { schema: { tasks } });
  return { sqlite, db };
}

// ---------------------------------------------------------------------------
// 1. findPrForBranch state mapping tests
// ---------------------------------------------------------------------------
describe("findPrForBranch — state mapping", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("draft PR: isDraft=true + state=OPEN maps to 'draft'", async () => {
    execSyncMock.mockReturnValue(
      JSON.stringify([
        {
          url: "https://github.com/owner/repo/pull/1",
          number: 1,
          state: "OPEN",
          headRefName: "orca/EMI-1",
          isDraft: true,
        },
      ]),
    );
    const result = await findPrForBranch("orca/EMI-1", "/tmp/repo", 1);
    expect(result.state).toBe("draft");
  });

  test("open PR: isDraft=false + state=OPEN maps to 'open'", async () => {
    execSyncMock.mockReturnValue(
      JSON.stringify([
        {
          url: "https://github.com/owner/repo/pull/2",
          number: 2,
          state: "OPEN",
          headRefName: "orca/EMI-2",
          isDraft: false,
        },
      ]),
    );
    const result = await findPrForBranch("orca/EMI-2", "/tmp/repo", 1);
    expect(result.state).toBe("open");
  });

  test("merged PR: state=MERGED maps to 'merged'", async () => {
    execSyncMock.mockReturnValue(
      JSON.stringify([
        {
          url: "https://github.com/owner/repo/pull/3",
          number: 3,
          state: "MERGED",
          headRefName: "orca/EMI-3",
          isDraft: false,
        },
      ]),
    );
    const result = await findPrForBranch("orca/EMI-3", "/tmp/repo", 1);
    expect(result.state).toBe("merged");
    expect(result.merged).toBe(true);
  });

  test("closed PR: state=CLOSED maps to 'closed'", async () => {
    execSyncMock.mockReturnValue(
      JSON.stringify([
        {
          url: "https://github.com/owner/repo/pull/4",
          number: 4,
          state: "CLOSED",
          headRefName: "orca/EMI-4",
          isDraft: false,
        },
      ]),
    );
    const result = await findPrForBranch("orca/EMI-4", "/tmp/repo", 1);
    expect(result.state).toBe("closed");
  });

  test("isDraft=true with MERGED state does NOT return 'draft' (merged takes precedence)", async () => {
    // Edge case: a draft PR that was merged (possible via API)
    execSyncMock.mockReturnValue(
      JSON.stringify([
        {
          url: "https://github.com/owner/repo/pull/5",
          number: 5,
          state: "MERGED",
          headRefName: "orca/EMI-5",
          isDraft: true,
        },
      ]),
    );
    const result = await findPrForBranch("orca/EMI-5", "/tmp/repo", 1);
    // isDraft && state === "OPEN" is false because state is MERGED, so it falls through correctly
    expect(result.state).toBe("merged");
  });

  test("missing isDraft field defaults to non-draft (backwards compat)", async () => {
    execSyncMock.mockReturnValue(
      JSON.stringify([
        {
          url: "https://github.com/owner/repo/pull/6",
          number: 6,
          state: "OPEN",
          headRefName: "orca/EMI-6",
          // isDraft deliberately omitted
        },
      ]),
    );
    const result = await findPrForBranch("orca/EMI-6", "/tmp/repo", 1);
    expect(result.state).toBe("open");
  });

  test("unexpected state value from gh falls through to 'closed'", async () => {
    execSyncMock.mockReturnValue(
      JSON.stringify([
        {
          url: "https://github.com/owner/repo/pull/7",
          number: 7,
          state: "BANANA",
          headRefName: "orca/EMI-7",
          isDraft: false,
        },
      ]),
    );
    const result = await findPrForBranch("orca/EMI-7", "/tmp/repo", 1);
    // BUG: any unknown state silently becomes "closed"
    // This is arguably wrong — "closed" implies a deliberate action
    expect(result.state).toBe("closed");
  });

  test("no PR found returns exists: false with no state", async () => {
    execSyncMock.mockReturnValue(JSON.stringify([]));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await findPrForBranch("orca/no-pr", "/tmp/repo", 1);
    expect(result.exists).toBe(false);
    expect(result.state).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. findPrByUrl state mapping tests
// ---------------------------------------------------------------------------
describe("findPrByUrl — state mapping", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns correct state for draft PR", () => {
    execSyncMock.mockReturnValue(
      JSON.stringify({
        url: "https://github.com/owner/repo/pull/10",
        number: 10,
        state: "OPEN",
        headRefName: "orca/EMI-10",
        isDraft: true,
      }),
    );
    const result = findPrByUrl(
      "https://github.com/owner/repo/pull/10",
      "/tmp/repo",
    );
    expect(result.state).toBe("draft");
  });

  test("returns correct state for open PR", () => {
    execSyncMock.mockReturnValue(
      JSON.stringify({
        url: "https://github.com/owner/repo/pull/11",
        number: 11,
        state: "OPEN",
        headRefName: "orca/EMI-11",
        isDraft: false,
      }),
    );
    const result = findPrByUrl(
      "https://github.com/owner/repo/pull/11",
      "/tmp/repo",
    );
    expect(result.state).toBe("open");
  });

  test("gh failure returns exists: false with no state", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("gh: not found");
    });
    const result = findPrByUrl(
      "https://github.com/owner/repo/pull/999",
      "/tmp/repo",
    );
    expect(result.exists).toBe(false);
    expect(result.state).toBeUndefined();
  });

  test("missing number in response returns exists: false", () => {
    execSyncMock.mockReturnValue(
      JSON.stringify({
        url: "https://github.com/owner/repo/pull/12",
        // number is missing
        state: "OPEN",
        isDraft: false,
      }),
    );
    const result = findPrByUrl(
      "https://github.com/owner/repo/pull/12",
      "/tmp/repo",
    );
    expect(result.exists).toBe(false);
    expect(result.state).toBeUndefined();
  });
});

const now = () => new Date().toISOString();
function baseTask(id: string, extra: Record<string, unknown> = {}) {
  return {
    linearIssueId: id,
    agentPrompt: "test",
    priority: 0,
    orcaStatus: "running" as const,
    repoPath: "/tmp/repo",
    createdAt: now(),
    updatedAt: now(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 3. DB migration and updateTaskPrInfo tests
// ---------------------------------------------------------------------------
describe("updateTaskPrInfo — DB operations", () => {
  test("sets prUrl and prState on a task", () => {
    const { db } = createTestDb();
    db.insert(tasks).values(baseTask("task-1")).run();

    db.update(tasks)
      .set({
        prUrl: "https://github.com/owner/repo/pull/42",
        prState: "open",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tasks.linearIssueId, "task-1"))
      .run();

    const task = db
      .select()
      .from(tasks)
      .where(eq(tasks.linearIssueId, "task-1"))
      .get();
    expect(task!.prUrl).toBe("https://github.com/owner/repo/pull/42");
    expect(task!.prState).toBe("open");
  });

  test("prState allows arbitrary string in DB (no constraint)", () => {
    const { db } = createTestDb();
    db.insert(tasks).values(baseTask("task-2")).run();

    // BUG: DB has no CHECK constraint on pr_state — any string is accepted.
    // The shared types define a union, but the DB doesn't enforce it.
    db.update(tasks)
      .set({
        prState: "invalid_state_value",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tasks.linearIssueId, "task-2"))
      .run();

    const task = db
      .select()
      .from(tasks)
      .where(eq(tasks.linearIssueId, "task-2"))
      .get();
    // This succeeds — the DB accepts anything
    expect(task!.prState).toBe("invalid_state_value");
  });

  test("prUrl and prState default to NULL for new tasks", () => {
    const { db } = createTestDb();
    db.insert(tasks)
      .values(baseTask("task-3", { orcaStatus: "backlog" }))
      .run();

    const task = db
      .select()
      .from(tasks)
      .where(eq(tasks.linearIssueId, "task-3"))
      .get();
    expect(task!.prUrl).toBeNull();
    expect(task!.prState).toBeNull();
  });

  test("setting prState without prUrl leaves prUrl null", () => {
    const { db } = createTestDb();
    db.insert(tasks)
      .values(baseTask("task-4", { prNumber: 42 }))
      .run();

    // This simulates what ci-merge.ts does: updateTaskPrInfo(db, taskId, { prState: "merged" })
    // It only sets prState, leaving prUrl untouched (null)
    db.update(tasks)
      .set({ prState: "merged", updatedAt: new Date().toISOString() })
      .where(eq(tasks.linearIssueId, "task-4"))
      .run();

    const task = db
      .select()
      .from(tasks)
      .where(eq(tasks.linearIssueId, "task-4"))
      .get();
    expect(task!.prNumber).toBe(42);
    expect(task!.prState).toBe("merged");
    // prUrl is still null — the frontend will show PR #42 linking to "#"
    expect(task!.prUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Migration sentinel correctness
// ---------------------------------------------------------------------------
describe("Migration 21 — sentinel-based migration", () => {
  test("migration adds pr_url and pr_state to existing table", () => {
    const sqlite = new Database(":memory:");
    // Create table WITHOUT pr_url and pr_state
    sqlite.exec(`
      CREATE TABLE tasks (
        linear_issue_id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL DEFAULT 0,
        orca_status TEXT NOT NULL DEFAULT 'backlog',
        repo_path TEXT NOT NULL DEFAULT '/tmp/repo',
        project_name TEXT NOT NULL DEFAULT '',
        pr_number INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Insert a task before migration
    sqlite.exec(
      "INSERT INTO tasks (linear_issue_id, identifier, title, description, priority, orca_status, repo_path, project_name, pr_number) VALUES ('existing-task', 'EMI-99', 'Existing', '', 0, 'done', '/tmp', 'test', 42)",
    );

    // Simulate migration 21
    const hasColumn = (table: string, col: string) => {
      const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
      }[];
      return cols.some((c) => c.name === col);
    };

    if (!hasColumn("tasks", "pr_url")) {
      sqlite.exec("ALTER TABLE tasks ADD COLUMN pr_url TEXT");
      sqlite.exec("ALTER TABLE tasks ADD COLUMN pr_state TEXT");
    }

    // Verify columns exist
    expect(hasColumn("tasks", "pr_url")).toBe(true);
    expect(hasColumn("tasks", "pr_state")).toBe(true);

    // Verify existing task has NULL for new columns (no backfill)
    const row = sqlite
      .prepare(
        "SELECT pr_url, pr_state, pr_number FROM tasks WHERE linear_issue_id = 'existing-task'",
      )
      .get() as {
      pr_url: string | null;
      pr_state: string | null;
      pr_number: number | null;
    };
    expect(row.pr_number).toBe(42);
    expect(row.pr_url).toBeNull(); // BUG: no backfill — frontend shows broken link
    expect(row.pr_state).toBeNull(); // BUG: no backfill — frontend shows "unknown" state
  });

  test("migration is idempotent (safe to run twice)", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE tasks (
        linear_issue_id TEXT PRIMARY KEY,
        pr_number INTEGER
      )
    `);

    const hasColumn = (table: string, col: string) => {
      const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
      }[];
      return cols.some((c) => c.name === col);
    };

    // Run migration twice — should not throw
    for (let i = 0; i < 2; i++) {
      if (!hasColumn("tasks", "pr_url")) {
        sqlite.exec("ALTER TABLE tasks ADD COLUMN pr_url TEXT");
        sqlite.exec("ALTER TABLE tasks ADD COLUMN pr_state TEXT");
      }
    }

    expect(hasColumn("tasks", "pr_url")).toBe(true);
    expect(hasColumn("tasks", "pr_state")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Frontend edge case: prNumber present but prUrl/prState missing
// ---------------------------------------------------------------------------
describe("Frontend display edge cases", () => {
  test("task with prNumber but null prUrl should not produce a clickable link to '#'", () => {
    // This test documents the edge case where a task has prNumber
    // (set by updateTaskDeployInfo) but no prUrl (not yet set, or
    // migrated from before EMI-379).
    //
    // The frontend renders: <a href={task.prUrl ?? "#"}>
    // When prUrl is null, the link goes to "#" — which is the current page.
    // This is a UX bug: the user clicks a PR number expecting GitHub,
    // but gets nothing.
    const taskData: Partial<Task> = {
      prNumber: 42,
      prUrl: null,
      prState: null,
    };

    // The frontend guard is `task.prNumber != null` — this is true
    const shouldShowPrLink = taskData.prNumber != null;
    expect(shouldShowPrLink).toBe(true);

    // But the link href would be "#" — broken
    const href = taskData.prUrl ?? "#";
    expect(href).toBe("#");
    // This is a bug: when prUrl is null but prNumber exists,
    // the frontend should either:
    // 1. Not show a link (just show the PR number as text), or
    // 2. Construct the URL from the repo path + PR number
  });

  test("prState type from DB is string, but frontend expects union type", () => {
    // Drizzle's inferred type for text("pr_state") is `string | null`
    // but the shared Task interface says `"draft" | "open" | "merged" | "closed" | null`
    // If somehow an invalid value gets into the DB, the frontend would render it
    // in the badge without any color mapping (would default to green/open color).
    const taskData: Partial<Task> = {
      prNumber: 42,
      prUrl: "https://github.com/owner/repo/pull/42",
      // @ts-expect-error — testing what happens with an invalid prState
      prState: "invalid",
    };

    // The frontend color mapping only handles draft/merged/closed/default(open)
    // An invalid state would get the green "open" color — misleading
    const color =
      taskData.prState === "draft"
        ? "#6e7781"
        : taskData.prState === "merged"
          ? "#8250df"
          : taskData.prState === "closed"
            ? "#cf222e"
            : "#1a7f37"; // falls through to "open" color
    expect(color).toBe("#1a7f37"); // looks like "open" even though it's invalid
  });
});

// ---------------------------------------------------------------------------
// 6. MCP server missing prUrl/prState
// ---------------------------------------------------------------------------
describe("MCP server data exposure", () => {
  test("MCP server task response should include prUrl and prState", () => {
    // The MCP server at src/mcp-server/index.ts explicitly maps task fields
    // to a response object. It includes prNumber and prBranchName but does
    // NOT include prUrl or prState. This means MCP consumers can't see
    // the PR link or state.
    //
    // Current MCP response fields (from code):
    const mcpFields = [
      "linearIssueId",
      "identifier",
      "title",
      "description",
      "orcaStatus",
      "priority",
      "retryCount",
      "reviewCycleCount",
      "prBranchName",
      "prNumber",
      "repoPath",
      "projectName",
      "parentIdentifier",
      "isParent",
      "fixReason",
      "createdAt",
      "updatedAt",
      "doneAt",
    ];

    // These are missing:
    expect(mcpFields).not.toContain("prUrl");
    expect(mcpFields).not.toContain("prState");
  });
});

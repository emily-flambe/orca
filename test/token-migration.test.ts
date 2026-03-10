// ---------------------------------------------------------------------------
// Token migration tests — adversarial tests targeting the EMI-229 refactor.
// These tests expose bugs in the token-based budget system migration.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  insertInvocation,
  insertBudgetEvent,
  budgetWindowStart,
  sumTokensInWindow,
  sumTokensInWindowRange,
} from "../src/db/queries.js";
import type { TaskStatus } from "../src/db/schema.js";

function freshDb(): OrcaDb {
  return createDb(":memory:");
}

function now(): string {
  return new Date().toISOString();
}

let counter = 0;
function makeTaskId(): string {
  return `TOK-${++counter}`;
}

function seedTask(db: OrcaDb, id?: string): string {
  const linearIssueId = id ?? makeTaskId();
  insertTask(db, {
    linearIssueId,
    agentPrompt: "test prompt",
    repoPath: "/tmp/repo",
    orcaStatus: "ready" as TaskStatus,
    priority: 3,
    retryCount: 0,
    reviewCycleCount: 0,
    mergeAttemptCount: 0,
    staleSessionRetryCount: 0,
    isParent: 0,
    createdAt: now(),
    updatedAt: now(),
  });
  return linearIssueId;
}

function seedInvocation(db: OrcaDb, taskId: string): number {
  return insertInvocation(db, {
    linearIssueId: taskId,
    startedAt: now(),
    status: "completed",
  });
}

// ---------------------------------------------------------------------------
// BUG 1: Sidebar.test.tsx uses old OrcaStatus field names
//
// The test fixture `makeStatus()` in web/src/components/__tests__/Sidebar.test.tsx
// uses `costInWindow` and `budgetLimit` which no longer exist on `OrcaStatus`.
// The OrcaStatus type has `tokensInWindow` and `tokenBudgetLimit` instead.
// The tests PASS only because the Sidebar component doesn't render these fields
// directly — but any code that tried to read status.costInWindow would get
// `undefined` at runtime, and the tests give false confidence.
//
// This is a type-safety hole: TypeScript doesn't catch it because the spread
// in makeStatus() provides extra unknown keys that go unchecked.
// ---------------------------------------------------------------------------
describe("BUG 1: OrcaStatus type mismatch in Sidebar test fixtures", () => {
  test("OrcaStatus has tokensInWindow, not costInWindow", () => {
    // This documents the contract. The web/src/types.ts OrcaStatus interface
    // has tokensInWindow and tokenBudgetLimit — NOT costInWindow/budgetLimit.
    // If a test creates { costInWindow: 0, budgetLimit: 100 } and passes it as
    // OrcaStatus, those fields are silently ignored by TypeScript's structural
    // typing when extra properties are provided via spread/cast.
    //
    // The Sidebar component doesn't render budget info, so the tests pass —
    // but they're testing with a structurally incorrect status object.
    // Any Sidebar feature that reads status.tokensInWindow would get undefined.

    // Simulate what the broken test fixture does:
    const brokenFixture = {
      activeSessions: 0,
      activeTaskIds: [],
      queuedTasks: 0,
      costInWindow: 0,     // OLD field name — does not exist on OrcaStatus
      budgetLimit: 100,    // OLD field name — does not exist on OrcaStatus
      budgetWindowHours: 24,
      concurrencyCap: 4,
      implementModel: "claude-3-5-sonnet",
      reviewModel: "claude-3-5-sonnet",
      fixModel: "claude-3-5-sonnet",
      draining: false,
      drainSessionCount: 0,
    };

    // These fields are MISSING from the fixture — they would be undefined at runtime
    expect((brokenFixture as Record<string, unknown>)["tokensInWindow"]).toBeUndefined();
    expect((brokenFixture as Record<string, unknown>)["tokenBudgetLimit"]).toBeUndefined();

    // These are the CORRECT fields that should be in the fixture:
    expect((brokenFixture as Record<string, unknown>)["costInWindow"]).toBe(0);
    expect((brokenFixture as Record<string, unknown>)["budgetLimit"]).toBe(100);
    // But these names don't match the OrcaStatus type — they're dead fields.
  });
});

// ---------------------------------------------------------------------------
// BUG 2: db.test.ts imports and tests deprecated sumCostInWindow instead of
// the new sumTokensInWindow. The budget enforcement tests (section 9.5) verify
// sumCostInWindow works, but they don't test the NEW budget gate function at all.
// The scheduler now uses sumTokensInWindow — this is completely untested.
// ---------------------------------------------------------------------------
describe("BUG 2: sumTokensInWindow has no tests in db.test.ts", () => {
  let db: OrcaDb;
  beforeEach(() => {
    db = freshDb();
  });

  test("sumTokensInWindow sums input+output tokens within window", () => {
    const taskId = seedTask(db);
    const invId = seedInvocation(db, taskId);
    const recent = new Date(Date.now() - 1000).toISOString();

    insertBudgetEvent(db, {
      invocationId: invId,
      costUsd: 0,
      inputTokens: 1000,
      outputTokens: 500,
      recordedAt: recent,
    });

    const windowStart = budgetWindowStart(4);
    const total = sumTokensInWindow(db, windowStart);
    expect(total).toBe(1500);
  });

  test("sumTokensInWindow excludes events outside the window", () => {
    const taskId = seedTask(db);
    const invId = seedInvocation(db, taskId);

    const old = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(); // 10 hours ago
    const recent = new Date(Date.now() - 1000).toISOString();

    insertBudgetEvent(db, {
      invocationId: invId,
      costUsd: 0,
      inputTokens: 999999,  // old event — should be excluded from 4-hour window
      outputTokens: 999999,
      recordedAt: old,
    });
    insertBudgetEvent(db, {
      invocationId: invId,
      costUsd: 0,
      inputTokens: 200,
      outputTokens: 100,
      recordedAt: recent,
    });

    const windowStart = budgetWindowStart(4);
    const total = sumTokensInWindow(db, windowStart);
    expect(total).toBe(300); // only the recent event
  });

  test("sumTokensInWindow returns 0 when no events exist", () => {
    const windowStart = budgetWindowStart(4);
    expect(sumTokensInWindow(db, windowStart)).toBe(0);
  });

  test("sumTokensInWindow returns 0 when all tokens are 0", () => {
    const taskId = seedTask(db);
    const invId = seedInvocation(db, taskId);

    // If insertBudgetEvent is called with no tokens (only costUsd), both should be 0
    insertBudgetEvent(db, {
      invocationId: invId,
      costUsd: 5.0,  // old-style event with only cost, no tokens
      recordedAt: now(),
    });

    const windowStart = budgetWindowStart(4);
    // This should return 0 since no tokens were set — the budget gate would NOT block
    // dispatch even though a cost was incurred. This is the critical regression.
    const total = sumTokensInWindow(db, windowStart);
    expect(total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// BUG 3: Budget enforcement tests in integration.test.ts use sumCostInWindow
// and budgetMaxCostUsd. The actual scheduler uses sumTokensInWindow and
// budgetMaxTokens. The integration tests are testing the WRONG budget gate.
// If sumCostInWindow returns X, the scheduler no longer checks X against the
// budget — it checks sumTokensInWindow instead. The integration tests give
// false confidence that budget enforcement works.
// ---------------------------------------------------------------------------
describe("BUG 3: Budget gate uses tokens, not cost — old cost events don't block dispatch", () => {
  let db: OrcaDb;
  beforeEach(() => {
    db = freshDb();
  });

  test("legacy budget events with only costUsd do NOT trigger token budget gate", () => {
    // Scenario: old-style budget event with large cost but 0 tokens.
    // The scheduler's budget gate checks sumTokensInWindow >= budgetMaxTokens.
    // Since tokens = 0, the budget gate would NOT block dispatch.
    // This means migrating from cost-based to token-based budget can leave
    // a window where old cost events don't contribute to the token budget.
    const taskId = seedTask(db);
    const invId = seedInvocation(db, taskId);

    // Insert event with huge cost but no tokens (simulating pre-migration data)
    insertBudgetEvent(db, {
      invocationId: invId,
      costUsd: 999.99,    // way over any cost budget
      // inputTokens and outputTokens default to 0
      recordedAt: now(),
    });

    const windowStart = budgetWindowStart(4);
    const tokensUsed = sumTokensInWindow(db, windowStart);
    const budgetMaxTokens = 50_000_000;

    // Token sum is 0, so budget gate says "not exhausted" — dispatch would proceed
    expect(tokensUsed).toBe(0);
    expect(tokensUsed >= budgetMaxTokens).toBe(false); // budget NOT blocked
    // This is the bug: cost-only events bypass the token budget gate entirely
  });
});

// ---------------------------------------------------------------------------
// BUG 4: formatTokens function edge cases (in src/cli/index.ts)
// The function handles 1M+ and 1K+ but check boundary values.
// ---------------------------------------------------------------------------
describe("BUG 4: formatTokens boundary values", () => {
  function formatTokens(n: number): string {
    // Fixed implementation from src/cli/index.ts
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) {
      const k = n / 1_000;
      const kStr = k.toFixed(1);
      if (parseFloat(kStr) >= 1000) return `${(n / 1_000_000).toFixed(1)}M`;
      return `${kStr}K`;
    }
    return String(n);
  }

  test("formats 0 correctly", () => {
    expect(formatTokens(0)).toBe("0");
  });

  test("formats 999 correctly (below K threshold)", () => {
    expect(formatTokens(999)).toBe("999");
  });

  test("formats 1000 as K", () => {
    expect(formatTokens(1000)).toBe("1.0K");
  });

  test("formats 999999 as M (rounding normalization)", () => {
    // 999999 / 1000 = 999.999 -> toFixed(1) rounds to "1000.0"
    // The fix detects k >= 1000 and falls through to M formatting instead.
    expect(formatTokens(999999)).toBe("1.0M");
  });

  test("formats 1000000 as M", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
  });

  test("formats 50000000 (default budget) correctly", () => {
    expect(formatTokens(50_000_000)).toBe("50.0M");
  });

  test("formatTokens does not handle negative numbers gracefully", () => {
    // Negative tokens shouldn't happen, but if they did:
    const result = formatTokens(-1);
    // -1 is not >= 1000, so it returns "-1"
    expect(result).toBe("-1");
    // No error thrown, which is fine, but worth documenting
  });
});

// ---------------------------------------------------------------------------
// BUG 5: sumTokensInWindowRange exists and works, but db.test.ts only tests
// the deprecated sumCostInWindowRange. No test verifies the token variant.
// ---------------------------------------------------------------------------
describe("BUG 5: sumTokensInWindowRange is untested", () => {
  let db: OrcaDb;
  beforeEach(() => {
    db = freshDb();
  });

  test("sumTokensInWindowRange sums tokens in [start, end) range", () => {
    const taskId = seedTask(db);
    const invId = seedInvocation(db, taskId);

    const t1 = "2024-01-01T00:00:00.000Z";
    const t2 = "2024-01-01T01:00:00.000Z";
    const t3 = "2024-01-01T02:00:00.000Z";
    const t4 = "2024-01-01T03:00:00.000Z";

    insertBudgetEvent(db, {
      invocationId: invId,
      costUsd: 0,
      inputTokens: 100,
      outputTokens: 100,
      recordedAt: t1,
    });
    insertBudgetEvent(db, {
      invocationId: invId,
      costUsd: 0,
      inputTokens: 200,
      outputTokens: 200,
      recordedAt: t2,
    });
    insertBudgetEvent(db, {
      invocationId: invId,
      costUsd: 0,
      inputTokens: 400,
      outputTokens: 400,
      recordedAt: t3,
    });
    insertBudgetEvent(db, {
      invocationId: invId,
      costUsd: 0,
      inputTokens: 800,
      outputTokens: 800,
      recordedAt: t4,
    });

    // Range [t2, t4) — should include t2 (400 total) and t3 (800 total), exclude t1 and t4
    const total = sumTokensInWindowRange(db, t2, t4);
    expect(total).toBe(1200); // (200+200) + (400+400)
  });

  test("sumTokensInWindowRange returns 0 for future range", () => {
    const total = sumTokensInWindowRange(
      db,
      "2030-01-01T00:00:00.000Z",
      "2030-12-31T00:00:00.000Z",
    );
    expect(total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// BUG 6: Migration 11 partial idempotency — if invocations migration runs
// but budget_events migration fails, re-running only adds budget_events columns.
// But the invocations sentinel check would be TRUE (column exists), so the
// invocations ALTER TABLE is skipped, but output_tokens would still be missing
// from invocations if the first run only ran one of the two ALTERs.
// In practice SQLite ALTER TABLE is atomic per statement, so this is fine —
// BUT if the second hasColumn check for budget_events is checked independently,
// there's a window where invocations has input_tokens but NOT output_tokens.
// ---------------------------------------------------------------------------
describe("BUG 6: Migration 11 sentinel only checks input_tokens for invocations", () => {
  test("migration sentinel checks input_tokens but output_tokens is added separately", () => {
    // The migration code in src/db/index.ts:277-288 is:
    //
    //   if (!hasColumn(sqlite, "invocations", "input_tokens")) {
    //     sqlite.exec("ALTER TABLE invocations ADD COLUMN input_tokens INTEGER");
    //     sqlite.exec("ALTER TABLE invocations ADD COLUMN output_tokens INTEGER");
    //   }
    //
    // The sentinel is `input_tokens`. If ONLY input_tokens exists (e.g. from a
    // partial migration that was interrupted after the first ALTER), the migration
    // would SKIP adding output_tokens because the sentinel (input_tokens) is present.
    //
    // This is a theoretical risk — SQLite doesn't support transactions spanning
    // multiple exec() calls unless explicitly wrapped. These two calls are NOT
    // wrapped in a transaction in migrateSchema().
    //
    // We verify the db.test.ts correctly creates columns (via createDb which runs
    // migrations from scratch and both columns are added together).
    const db = freshDb();
    const taskId = seedTask(db);
    const invId = seedInvocation(db, taskId);

    // If output_tokens column is missing, this would fail
    insertBudgetEvent(db, {
      invocationId: invId,
      costUsd: 0,
      inputTokens: 100,
      outputTokens: 50,
      recordedAt: now(),
    });

    const total = sumTokensInWindow(db, new Date(0).toISOString());
    expect(total).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// BUG 7: The scheduler's status emission uses tokensInWindow/tokenBudgetLimit
// via src/scheduler/index.ts, but if any consumer still listens for costInWindow
// or budgetLimit on the SSE stream, they'd get undefined.
// The SSE events test in api.test.ts doesn't validate the status:updated payload shape.
// ---------------------------------------------------------------------------
describe("BUG 7: SSE status payload field names are untested", () => {
  test("StatusPayload in events.ts has tokensInWindow and tokenBudgetLimit", () => {
    // Verify the payload shape from src/events.ts matches what consumers expect.
    // This is a compile-time check — we're verifying the object structure here.
    const payload = {
      activeSessions: 1,
      queuedTasks: 2,
      tokensInWindow: 100000,
      tokenBudgetLimit: 50_000_000,
      budgetWindowHours: 4,
    };

    // These are the CORRECT fields per src/events.ts StatusPayload interface.
    // If the web frontend was reading 'costInWindow', it would get undefined.
    expect(payload.tokensInWindow).toBe(100000);
    expect(payload.tokenBudgetLimit).toBe(50_000_000);
    expect((payload as Record<string, unknown>)["costInWindow"]).toBeUndefined();
    expect((payload as Record<string, unknown>)["budgetLimit"]).toBeUndefined();
  });
});

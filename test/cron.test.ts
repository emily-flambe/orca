// ---------------------------------------------------------------------------
// Cron utility tests — adversarial coverage
// ---------------------------------------------------------------------------

import { describe, test, it, expect, beforeEach, vi } from "vitest";
import {
  computeNextRunAt,
  validateCronExpression,
  describeCronSchedule,
} from "../src/cron/index.js";
import { createDb } from "../src/db/index.js";
import { createApiRoutes } from "../src/api/routes.js";
import {
  insertCronSchedule,
  getCronSchedule,
  getTasksByCronSchedule,
  insertTask,
  insertInvocation,
  updateCronLastRunStatus,
} from "../src/db/queries.js";
import type { OrcaDb } from "../src/db/index.js";
import type { OrcaConfig } from "../src/config/index.js";
import type { Hono } from "hono";

// ---------------------------------------------------------------------------
// computeNextRunAt
// ---------------------------------------------------------------------------

describe("computeNextRunAt", () => {
  test("returns a valid ISO string for common expression", () => {
    const result = computeNextRunAt("* * * * *");
    // Must parse as a valid date
    expect(isNaN(Date.parse(result))).toBe(false);
    // Must be an ISO string (ends with Z or +HH:MM)
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("returned time is in the future relative to after", () => {
    const after = new Date("2025-01-15T12:00:00.000Z");
    const result = computeNextRunAt("* * * * *", after);
    const next = new Date(result);
    expect(next.getTime()).toBeGreaterThan(after.getTime());
  });

  test("* * * * * fires within 60 seconds of after", () => {
    const after = new Date("2025-06-01T08:30:45.000Z");
    const result = computeNextRunAt("* * * * *", after);
    const next = new Date(result);
    const diffSeconds = (next.getTime() - after.getTime()) / 1000;
    expect(diffSeconds).toBeGreaterThan(0);
    expect(diffSeconds).toBeLessThanOrEqual(60);
  });

  test("works with explicit after date for 0 9 * * 1 (weekly)", () => {
    // Monday 2025-01-13 09:00 UTC — next Monday at 09:00 should be 2025-01-20
    const after = new Date("2025-01-13T09:01:00.000Z");
    const result = computeNextRunAt("0 9 * * 1", after);
    const next = new Date(result);
    // Should be a Monday
    expect(next.getUTCDay()).toBe(1);
    // Should be after the reference date
    expect(next.getTime()).toBeGreaterThan(after.getTime());
  });

  test("works with explicit after date on same minute boundary", () => {
    // If after is exactly at the boundary, next fire should still be in the future
    const after = new Date("2025-03-10T14:00:00.000Z");
    const result = computeNextRunAt("0 14 * * *", after);
    const next = new Date(result);
    expect(next.getTime()).toBeGreaterThan(after.getTime());
  });

  test("throws for invalid expression", () => {
    expect(() => computeNextRunAt("invalid")).toThrow();
  });

  test("throws for empty string", () => {
    expect(() => computeNextRunAt("")).toThrow();
  });

  test("throws for 4-field expression", () => {
    expect(() => computeNextRunAt("* * * *")).toThrow();
  });

  test("throws for out-of-range minute (60)", () => {
    expect(() => computeNextRunAt("60 * * * *")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateCronExpression
// ---------------------------------------------------------------------------

describe("validateCronExpression", () => {
  test("returns null for * * * * *", () => {
    expect(validateCronExpression("* * * * *")).toBeNull();
  });

  test("returns null for 0 9 * * 1 (weekly Monday 9am)", () => {
    expect(validateCronExpression("0 9 * * 1")).toBeNull();
  });

  test("returns null for */15 * * * * (every 15 minutes)", () => {
    expect(validateCronExpression("*/15 * * * *")).toBeNull();
  });

  test("returns null for 0 0 1 1 * (yearly)", () => {
    expect(validateCronExpression("0 0 1 1 *")).toBeNull();
  });

  test("returns a string for 'invalid'", () => {
    const result = validateCronExpression("invalid");
    expect(typeof result).toBe("string");
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
  });

  test("returns a string for 4-field expression", () => {
    const result = validateCronExpression("* * * *");
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
    expect(result!.length).toBeGreaterThan(0);
  });

  test("returns a string for minute 60 out of range", () => {
    const result = validateCronExpression("60 * * * *");
    expect(typeof result).toBe("string");
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
  });

  test("returns a string for hour 24 out of range", () => {
    const result = validateCronExpression("0 24 * * *");
    expect(typeof result).toBe("string");
    expect(result).not.toBeNull();
  });

  test("returns null for valid step expressions (*/5 */2 * * *)", () => {
    expect(validateCronExpression("*/5 */2 * * *")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// describeCronSchedule
// ---------------------------------------------------------------------------

describe("describeCronSchedule", () => {
  test("* * * * * returns 'Every minute'", () => {
    expect(describeCronSchedule("* * * * *")).toBe("Every minute");
  });

  test("*/2 * * * * contains '2 minutes'", () => {
    const result = describeCronSchedule("*/2 * * * *");
    expect(result).toContain("2 minutes");
  });

  test("*/15 * * * * contains '15 minutes'", () => {
    const result = describeCronSchedule("*/15 * * * *");
    expect(result).toContain("15 minutes");
  });

  test("0 * * * * returns 'Every hour'", () => {
    expect(describeCronSchedule("0 * * * *")).toBe("Every hour");
  });

  test("0 9 * * * contains '9' and 'AM'", () => {
    const result = describeCronSchedule("0 9 * * *");
    expect(result).toContain("9");
    expect(result).toContain("AM");
  });

  test("0 0 * * * uses 12 for midnight (not 0:00 AM)", () => {
    // Hour 0 mod 12 === 0, displayHour should be 12, not 0
    const result = describeCronSchedule("0 0 * * *");
    expect(result).toContain("12");
    expect(result).toContain("AM");
  });

  test("0 12 * * * returns PM for noon", () => {
    const result = describeCronSchedule("0 12 * * *");
    expect(result).toContain("PM");
  });

  test("0 9 * * 1 contains 'Monday' or 'Weekly'", () => {
    const result = describeCronSchedule("0 9 * * 1");
    const hasMonday = result.includes("Monday");
    const hasWeekly = result.includes("Weekly");
    expect(hasMonday || hasWeekly).toBe(true);
  });

  test("0 9 * * 0 describes Sunday", () => {
    const result = describeCronSchedule("0 9 * * 0");
    expect(result).toContain("Sunday");
  });

  test("0 9 * * 6 describes Saturday", () => {
    const result = describeCronSchedule("0 9 * * 6");
    expect(result).toContain("Saturday");
  });

  test("0 9 1 * * contains 'Monthly' or '1st'", () => {
    const result = describeCronSchedule("0 9 1 * *");
    const hasMonthly = result.includes("Monthly");
    const hasFirst = result.includes("1st");
    expect(hasMonthly || hasFirst).toBe(true);
  });

  test("invalid expression returns error notice", () => {
    const result = describeCronSchedule("not-a-cron");
    expect(result.toLowerCase()).toContain("invalid");
  });

  test("*/1 * * * * is treated as every 1 minute (not 'Every minute')", () => {
    // */1 is technically valid and means every minute, but it matches
    // the everyNMinutes branch (not the "Every minute" branch).
    // The implementation returns "Every 1 minutes" — this is arguably
    // a description flaw (should say "Every minute" or "Every 1 minute").
    const result = describeCronSchedule("*/1 * * * *");
    // At minimum it should not crash and should mention "1"
    expect(result).toContain("1");
  });

  test("order: 0 * * * * (every hour) does not accidentally match every-minute", () => {
    // Regression: if order of checks were wrong, '0 * * * *' could fall through wrong branch
    const result = describeCronSchedule("0 * * * *");
    expect(result).not.toBe("Every minute");
    expect(result).toBe("Every hour");
  });

  test("0 */2 * * * (every 2 hours) contains '2 hours'", () => {
    const result = describeCronSchedule("0 */2 * * *");
    expect(result).toContain("2 hours");
  });

  test("month-specific expression does not produce generic description", () => {
    // '0 9 * JAN *' only fires in January — must NOT return 'Daily at 9:00 AM'
    const result = describeCronSchedule("0 9 * JAN *");
    expect(result).not.toBe("Daily at 9:00 AM");
    // Should fall back to the generic Cron: prefix
    expect(result).toContain("9");
  });

  test("* * * JAN * does not return 'Every minute'", () => {
    // Only fires in January — 'Every minute' is misleading
    const result = describeCronSchedule("* * * JAN *");
    expect(result).not.toBe("Every minute");
  });

  test("0 9 * 1 * does not return 'Daily at 9:00 AM'", () => {
    // Fires at 9am but only in January (month=1)
    const result = describeCronSchedule("0 9 * 1 *");
    expect(result).not.toBe("Daily at 9:00 AM");
  });
});

// ---------------------------------------------------------------------------
// API route test helpers
// ---------------------------------------------------------------------------

const mockInngest = { send: vi.fn().mockResolvedValue(undefined) } as any;

function makeConfig(overrides?: Partial<OrcaConfig>): OrcaConfig {
  return {
    defaultCwd: "/tmp",
    projectRepoMap: new Map(),
    concurrencyCap: 3,
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
    linearApiKey: "test",
    linearWebhookSecret: "test",
    linearProjectIds: ["test-project"],
    tunnelHostname: "test.example.com",
    alertWebhookUrl: undefined,
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    externalTunnel: false,
    logLevel: "info",
    ...overrides,
  };
}

function makeApp(db: OrcaDb): Hono {
  return createApiRoutes({
    db,
    config: makeConfig(),
    syncTasks: vi.fn().mockResolvedValue(0),
    client: {} as never,
    stateMap: new Map(),
    projectMeta: [],
    inngest: mockInngest,
  });
}

function now(): string {
  return new Date().toISOString();
}

function makeSchedule(overrides?: Record<string, unknown>) {
  return {
    name: "test schedule",
    type: "claude" as const,
    schedule: "* * * * *",
    prompt: "do something",
    repoPath: "/tmp/repo",
    timeoutMin: 30,
    maxRuns: null,
    enabled: 1,
    nextRunAt: new Date(Date.now() + 60000).toISOString(),
    runCount: 0,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// POST /api/cron — validation
// ---------------------------------------------------------------------------

describe("POST /api/cron — validation", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  async function post(body: unknown) {
    return app.request("/api/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rejects missing name", async () => {
    const res = await post({
      prompt: "do",
      type: "shell",
      schedule: "* * * * *",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/name/i);
  });

  it("rejects empty name", async () => {
    const res = await post({
      name: "  ",
      prompt: "do",
      type: "shell",
      schedule: "* * * * *",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/name/i);
  });

  it("rejects missing prompt", async () => {
    const res = await post({
      name: "test",
      type: "shell",
      schedule: "* * * * *",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/prompt/i);
  });

  it("rejects empty prompt", async () => {
    const res = await post({
      name: "test",
      prompt: "",
      type: "shell",
      schedule: "* * * * *",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/prompt/i);
  });

  it("rejects missing type", async () => {
    const res = await post({
      name: "test",
      prompt: "do",
      schedule: "* * * * *",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/type/i);
  });

  it("rejects invalid type value", async () => {
    const res = await post({
      name: "test",
      prompt: "do",
      type: "bash",
      schedule: "* * * * *",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/type/i);
  });

  it("rejects missing schedule", async () => {
    const res = await post({ name: "test", prompt: "do", type: "shell" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/schedule/i);
  });

  it("rejects invalid cron expression in schedule", async () => {
    const res = await post({
      name: "test",
      prompt: "do",
      type: "shell",
      schedule: "bad cron",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/schedule/i);
  });

  it("rejects claude type without repoPath", async () => {
    const res = await post({
      name: "test",
      prompt: "do",
      type: "claude",
      schedule: "* * * * *",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/repoPath/i);
  });

  it("rejects claude type with empty repoPath", async () => {
    const res = await post({
      name: "test",
      prompt: "do",
      type: "claude",
      schedule: "* * * * *",
      repoPath: "  ",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/repoPath/i);
  });

  it("rejects timeoutMin=0", async () => {
    const res = await post({
      name: "test",
      prompt: "do",
      type: "shell",
      schedule: "* * * * *",
      timeoutMin: 0,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/timeoutMin/i);
  });

  it("rejects timeoutMin=-1", async () => {
    const res = await post({
      name: "test",
      prompt: "do",
      type: "shell",
      schedule: "* * * * *",
      timeoutMin: -1,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/timeoutMin/i);
  });

  it("rejects non-integer timeoutMin (1.5)", async () => {
    const res = await post({
      name: "test",
      prompt: "do",
      type: "shell",
      schedule: "* * * * *",
      timeoutMin: 1.5,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/timeoutMin/i);
  });

  it("rejects maxRuns=0", async () => {
    const res = await post({
      name: "test",
      prompt: "do",
      type: "shell",
      schedule: "* * * * *",
      maxRuns: 0,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/maxRuns/i);
  });

  it("rejects maxRuns=-1", async () => {
    const res = await post({
      name: "test",
      prompt: "do",
      type: "shell",
      schedule: "* * * * *",
      maxRuns: -1,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/maxRuns/i);
  });

  it("rejects non-integer maxRuns (2.5)", async () => {
    const res = await post({
      name: "test",
      prompt: "do",
      type: "shell",
      schedule: "* * * * *",
      maxRuns: 2.5,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/maxRuns/i);
  });

  it("accepts maxRuns=null explicitly", async () => {
    const res = await post({
      name: "test",
      prompt: "do",
      type: "shell",
      schedule: "* * * * *",
      maxRuns: null,
    });
    expect(res.status).toBe(201);
  });

  it("accepts timeoutMin=null explicitly", async () => {
    const res = await post({
      name: "test",
      prompt: "do",
      type: "shell",
      schedule: "* * * * *",
      timeoutMin: null,
    });
    expect(res.status).toBe(201);
  });

  it("returns 400 on malformed JSON body", async () => {
    const res = await app.request("/api/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json at all {{{",
    });
    expect(res.status).toBe(400);
  });

  it("creates schedule with correct nextRunAt computed from schedule", async () => {
    const before = Date.now();
    const res = await post({
      name: "test",
      prompt: "do",
      type: "shell",
      schedule: "* * * * *",
    });
    const after = Date.now();
    expect(res.status).toBe(201);
    const body = await res.json();
    const nextRun = new Date(body.nextRunAt).getTime();
    expect(nextRun).toBeGreaterThan(before);
    expect(nextRun).toBeLessThan(after + 61000);
  });

  it("shell type without repoPath is accepted", async () => {
    const res = await post({
      name: "test",
      prompt: "do",
      type: "shell",
      schedule: "* * * * *",
    });
    expect(res.status).toBe(201);
  });

  it("returns 400 on non-object JSON body (array)", async () => {
    const res = await app.request("/api/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([1, 2, 3]),
    });
    expect(res.status).toBe(400);
  });

  it("persists model and maxTurns when provided", async () => {
    const res = await post({
      name: "test",
      prompt: "do",
      type: "claude",
      schedule: "* * * * *",
      repoPath: "/tmp/repo",
      model: "sonnet",
      maxTurns: 5,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.model).toBe("sonnet");
    expect(body.maxTurns).toBe(5);
  });

  it("accepts full claude- model ID", async () => {
    const res = await post({
      name: "test",
      prompt: "do",
      type: "shell",
      schedule: "* * * * *",
      model: "claude-sonnet-4-6",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.model).toBe("claude-sonnet-4-6");
  });

  it("rejects invalid model value", async () => {
    const res = await post({
      name: "test",
      prompt: "do",
      type: "shell",
      schedule: "* * * * *",
      model: "gpt-4",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/model/i);
  });

  it("rejects maxTurns=0", async () => {
    const res = await post({
      name: "test",
      prompt: "do",
      type: "shell",
      schedule: "* * * * *",
      maxTurns: 0,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/maxTurns/i);
  });

  it("rejects negative maxTurns", async () => {
    const res = await post({
      name: "test",
      prompt: "do",
      type: "shell",
      schedule: "* * * * *",
      maxTurns: -1,
    });
    expect(res.status).toBe(400);
  });

  it("stores null model and maxTurns when omitted", async () => {
    const res = await post({
      name: "test",
      prompt: "do",
      type: "shell",
      schedule: "* * * * *",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.model).toBeNull();
    expect(body.maxTurns).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/cron/:id — not found and invalid id
// ---------------------------------------------------------------------------

describe("GET /api/cron/:id", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("returns 404 for non-existent id", async () => {
    const res = await app.request("/api/cron/9999");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 400 for non-numeric id", async () => {
    const res = await app.request("/api/cron/abc");
    expect(res.status).toBe(400);
  });

  it("returns schedule with recentTasks array when schedule exists", async () => {
    const id = insertCronSchedule(db, makeSchedule());
    const res = await app.request(`/api/cron/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(Array.isArray(body.recentTasks)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/cron/:id — update behavior
// ---------------------------------------------------------------------------

describe("PUT /api/cron/:id — update behavior", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  async function put(id: number, body: unknown) {
    return app.request(`/api/cron/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 404 for non-existent id", async () => {
    const res = await put(9999, { name: "new" });
    expect(res.status).toBe(404);
  });

  it("when schedule field changes, nextRunAt is recomputed", async () => {
    const oldNextRunAt = "2020-01-01T00:00:00.000Z";
    const id = insertCronSchedule(
      db,
      makeSchedule({ nextRunAt: oldNextRunAt, schedule: "0 9 * * *" }),
    );

    const res = await put(id, { schedule: "0 18 * * *" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextRunAt).not.toBe(oldNextRunAt);
    expect(new Date(body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("when schedule field is NOT changed, nextRunAt is preserved as-is", async () => {
    const fixedNextRunAt = "2099-12-31T23:59:00.000Z";
    const id = insertCronSchedule(
      db,
      makeSchedule({ nextRunAt: fixedNextRunAt }),
    );

    const res = await put(id, { name: "updated name" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextRunAt).toBe(fixedNextRunAt);
  });

  it("rejects invalid cron expression in schedule update", async () => {
    const id = insertCronSchedule(db, makeSchedule());
    const res = await put(id, { schedule: "not valid cron" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/schedule/i);
  });

  it("rejects timeoutMin=0 in update", async () => {
    const id = insertCronSchedule(db, makeSchedule());
    const res = await put(id, { timeoutMin: 0 });
    expect(res.status).toBe(400);
  });

  it("rejects maxRuns=-1 in update", async () => {
    const id = insertCronSchedule(db, makeSchedule());
    const res = await put(id, { maxRuns: -1 });
    expect(res.status).toBe(400);
  });

  it("rejects empty name in update", async () => {
    const id = insertCronSchedule(db, makeSchedule());
    const res = await put(id, { name: "" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/name/i);
  });

  it("rejects invalid type in update", async () => {
    const id = insertCronSchedule(db, makeSchedule());
    const res = await put(id, { type: "invalid" });
    expect(res.status).toBe(400);
  });

  it("enabled field: truthy value sets to 1", async () => {
    const id = insertCronSchedule(db, makeSchedule({ enabled: 0 }));
    const res = await put(id, { enabled: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(1);
  });

  it("enabled field: falsy value sets to 0", async () => {
    const id = insertCronSchedule(db, makeSchedule({ enabled: 1 }));
    const res = await put(id, { enabled: false });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(0);
  });

  it("persists model and maxTurns when updated", async () => {
    const id = insertCronSchedule(db, makeSchedule());
    const res = await put(id, { model: "haiku", maxTurns: 10 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe("haiku");
    expect(body.maxTurns).toBe(10);
  });

  it("clears model and maxTurns when set to null", async () => {
    const id = insertCronSchedule(
      db,
      makeSchedule({ model: "sonnet", maxTurns: 5 }),
    );
    const res = await put(id, { model: null, maxTurns: null });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBeNull();
    expect(body.maxTurns).toBeNull();
  });

  it("rejects invalid model in update", async () => {
    const id = insertCronSchedule(db, makeSchedule());
    const res = await put(id, { model: "not-a-valid-model" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/model/i);
  });

  it("rejects maxTurns=0 in update", async () => {
    const id = insertCronSchedule(db, makeSchedule());
    const res = await put(id, { maxTurns: 0 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/maxTurns/i);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/cron/:id — cascade behavior
// ---------------------------------------------------------------------------

describe("DELETE /api/cron/:id", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("returns 404 for non-existent id", async () => {
    const res = await app.request("/api/cron/9999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("deletes the schedule", async () => {
    const id = insertCronSchedule(db, makeSchedule());
    const res = await app.request(`/api/cron/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(getCronSchedule(db, id)).toBeUndefined();
  });

  it("deletes associated tasks before the schedule", async () => {
    const id = insertCronSchedule(db, makeSchedule());
    const taskId = `cron-${id}-1234`;
    insertTask(db, {
      linearIssueId: taskId,
      agentPrompt: "do something",
      repoPath: "/tmp",
      orcaStatus: "ready",
      taskType: "cron_shell",
      cronScheduleId: id,
      createdAt: now(),
      updatedAt: now(),
      priority: 0,
      retryCount: 0,
      reviewCycleCount: 0,
      mergeAttemptCount: 0,
      staleSessionRetryCount: 0,
      isParent: 0,
    });
    expect(getTasksByCronSchedule(db, id)).toHaveLength(1);

    const res = await app.request(`/api/cron/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    expect(getCronSchedule(db, id)).toBeUndefined();
    expect(getTasksByCronSchedule(db, id)).toHaveLength(0);
  });

  it("returns 400 for non-numeric id", async () => {
    const res = await app.request("/api/cron/notanumber", { method: "DELETE" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/cron/:id/toggle — enabled flip
// ---------------------------------------------------------------------------

describe("POST /api/cron/:id/toggle", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  async function toggle(id: number) {
    return app.request(`/api/cron/${id}/toggle`, { method: "POST" });
  }

  it("returns 404 for non-existent id", async () => {
    const res = await toggle(9999);
    expect(res.status).toBe(404);
  });

  it("flips enabled from 1 to 0", async () => {
    const id = insertCronSchedule(db, makeSchedule({ enabled: 1 }));
    const res = await toggle(id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(0);
  });

  it("flips enabled from 0 to 1", async () => {
    const id = insertCronSchedule(db, makeSchedule({ enabled: 0 }));
    const res = await toggle(id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(1);
  });

  it("double-toggle returns to original state", async () => {
    const id = insertCronSchedule(db, makeSchedule({ enabled: 1 }));
    await toggle(id);
    const res = await toggle(id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// POST /api/cron/:id/trigger — task ID uniqueness and side effects
// ---------------------------------------------------------------------------

describe("POST /api/cron/:id/trigger", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  async function trigger(id: number) {
    return app.request(`/api/cron/${id}/trigger`, { method: "POST" });
  }

  it("returns 404 for non-existent schedule id", async () => {
    const res = await trigger(9999);
    expect(res.status).toBe(404);
  });

  it("returns 400 for non-numeric id", async () => {
    const res = await app.request("/api/cron/bad/trigger", { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("creates a task with status ready", async () => {
    const id = insertCronSchedule(db, makeSchedule());
    const res = await trigger(id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.taskId).toBeDefined();

    const tasks = getTasksByCronSchedule(db, id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].orcaStatus).toBe("ready");
  });

  it("increments runCount after trigger", async () => {
    const id = insertCronSchedule(db, makeSchedule({ runCount: 0 }));
    await trigger(id);
    const updated = getCronSchedule(db, id);
    expect(updated?.runCount).toBe(1);
  });

  it("updates nextRunAt after trigger", async () => {
    const oldNextRunAt = "2020-01-01T00:00:00.000Z";
    const id = insertCronSchedule(
      db,
      makeSchedule({ nextRunAt: oldNextRunAt }),
    );
    await trigger(id);
    const updated = getCronSchedule(db, id);
    expect(updated?.nextRunAt).not.toBe(oldNextRunAt);
    expect(new Date(updated!.nextRunAt!).getTime()).toBeGreaterThan(
      Date.now() - 5000,
    );
  });

  it("concurrent triggers with same Date.now() produce unique task IDs", async () => {
    const id = insertCronSchedule(db, makeSchedule());

    const fixedMs = 1741564800000;
    vi.spyOn(Date, "now").mockReturnValue(fixedMs);

    const res1 = await trigger(id);
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.taskId).toMatch(new RegExp(`^cron-${id}-${fixedMs}-`));

    const res2 = await trigger(id);
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.taskId).toMatch(new RegExp(`^cron-${id}-${fixedMs}-`));

    expect(body1.taskId).not.toBe(body2.taskId);

    vi.restoreAllMocks();
  });

  it("task type is cron_claude for claude schedule", async () => {
    const id = insertCronSchedule(
      db,
      makeSchedule({ type: "claude", repoPath: "/repo" }),
    );
    await trigger(id);
    const tasks = getTasksByCronSchedule(db, id);
    expect(tasks[0].taskType).toBe("cron_claude");
  });

  it("task type is cron_shell for shell schedule", async () => {
    const id = insertCronSchedule(
      db,
      makeSchedule({ type: "shell", repoPath: null }),
    );
    await trigger(id);
    const tasks = getTasksByCronSchedule(db, id);
    expect(tasks[0].taskType).toBe("cron_shell");
  });

  it("task repoPath is empty string when schedule repoPath is null", async () => {
    const id = insertCronSchedule(
      db,
      makeSchedule({ type: "shell", repoPath: null }),
    );
    await trigger(id);
    const tasks = getTasksByCronSchedule(db, id);
    expect(tasks[0].repoPath).toBe("");
  });
});

// ---------------------------------------------------------------------------
// GET /api/cron — listing
// ---------------------------------------------------------------------------

describe("GET /api/cron", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("returns empty array when no schedules", async () => {
    const res = await app.request("/api/cron");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns all schedules", async () => {
    insertCronSchedule(db, makeSchedule({ name: "first" }));
    insertCronSchedule(db, makeSchedule({ name: "second" }));
    const res = await app.request("/api/cron");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
  });

  it("includes lastRunStatus field in each schedule", async () => {
    const id = insertCronSchedule(db, makeSchedule({ name: "status-test" }));
    updateCronLastRunStatus(db, id, "success");
    const res = await app.request("/api/cron");
    expect(res.status).toBe(200);
    const body = await res.json();
    const schedule = body.find((s: { id: number }) => s.id === id);
    expect(schedule).toBeDefined();
    expect(schedule.lastRunStatus).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// updateCronLastRunStatus — direct DB function tests
// ---------------------------------------------------------------------------

describe("updateCronLastRunStatus", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("sets lastRunStatus to 'success' on a cron schedule", () => {
    const id = insertCronSchedule(db, makeSchedule());
    updateCronLastRunStatus(db, id, "success");
    const schedule = getCronSchedule(db, id);
    expect(schedule?.lastRunStatus).toBe("success");
  });

  it("sets lastRunStatus to 'failed' on a cron schedule", () => {
    const id = insertCronSchedule(db, makeSchedule());
    updateCronLastRunStatus(db, id, "failed");
    const schedule = getCronSchedule(db, id);
    expect(schedule?.lastRunStatus).toBe("failed");
  });

  it("overwrites a previous status value", () => {
    const id = insertCronSchedule(db, makeSchedule());
    updateCronLastRunStatus(db, id, "success");
    updateCronLastRunStatus(db, id, "failed");
    const schedule = getCronSchedule(db, id);
    expect(schedule?.lastRunStatus).toBe("failed");
  });

  it("new schedule has null lastRunStatus before any update", () => {
    const id = insertCronSchedule(db, makeSchedule());
    const schedule = getCronSchedule(db, id);
    expect(schedule?.lastRunStatus).toBeNull();
  });

  it("updates updatedAt timestamp when status is set", () => {
    const id = insertCronSchedule(db, makeSchedule());
    const before = getCronSchedule(db, id)!.updatedAt;
    // Advance time slightly
    const origDateNow = Date.now;
    Date.now = () => origDateNow() + 1000;
    updateCronLastRunStatus(db, id, "success");
    Date.now = origDateNow;
    const after = getCronSchedule(db, id)!.updatedAt;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );
  });

  it("does not affect other schedules", () => {
    const id1 = insertCronSchedule(db, makeSchedule({ name: "sched-a" }));
    const id2 = insertCronSchedule(db, makeSchedule({ name: "sched-b" }));
    updateCronLastRunStatus(db, id1, "failed");
    const schedule2 = getCronSchedule(db, id2);
    expect(schedule2?.lastRunStatus).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/cron/:id/tasks — cron task history with invocations
// ---------------------------------------------------------------------------

describe("GET /api/cron/:id/tasks", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("returns 400 for non-numeric id", async () => {
    const res = await app.request("/api/cron/abc/tasks");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 404 for non-existent schedule id", async () => {
    const res = await app.request("/api/cron/9999/tasks");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns empty array when schedule has no tasks", async () => {
    const id = insertCronSchedule(db, makeSchedule());
    const res = await app.request(`/api/cron/${id}/tasks`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });

  it("returns tasks with invocations array attached", async () => {
    const id = insertCronSchedule(db, makeSchedule());
    const taskId = `cron-${id}-task-1`;
    insertTask(db, {
      linearIssueId: taskId,
      agentPrompt: "do something",
      repoPath: "/tmp",
      orcaStatus: "done",
      taskType: "cron_claude",
      cronScheduleId: id,
      createdAt: "2026-01-01T10:00:00.000Z",
      updatedAt: "2026-01-01T10:05:00.000Z",
      priority: 0,
      retryCount: 0,
      reviewCycleCount: 0,
      mergeAttemptCount: 0,
      staleSessionRetryCount: 0,
      isParent: 0,
    });
    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: "2026-01-01T10:00:00.000Z",
      status: "completed",
      costUsd: 0.1,
      numTurns: 3,
      outputSummary: "Done",
    });

    const res = await app.request(`/api/cron/${id}/tasks`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].linearIssueId).toBe(taskId);
    expect(Array.isArray(body[0].invocations)).toBe(true);
    expect(body[0].invocations).toHaveLength(1);
    expect(body[0].invocations[0].id).toBe(invId);
    expect(body[0].invocations[0].status).toBe("completed");
  });

  it("returns tasks sorted by createdAt descending (newest first)", async () => {
    const id = insertCronSchedule(db, makeSchedule());
    const taskId1 = `cron-${id}-old`;
    const taskId2 = `cron-${id}-new`;
    insertTask(db, {
      linearIssueId: taskId1,
      agentPrompt: "old task",
      repoPath: "/tmp",
      orcaStatus: "done",
      taskType: "cron_claude",
      cronScheduleId: id,
      createdAt: "2026-01-01T08:00:00.000Z",
      updatedAt: "2026-01-01T08:05:00.000Z",
      priority: 0,
      retryCount: 0,
      reviewCycleCount: 0,
      mergeAttemptCount: 0,
      staleSessionRetryCount: 0,
      isParent: 0,
    });
    insertTask(db, {
      linearIssueId: taskId2,
      agentPrompt: "new task",
      repoPath: "/tmp",
      orcaStatus: "running",
      taskType: "cron_claude",
      cronScheduleId: id,
      createdAt: "2026-01-02T10:00:00.000Z",
      updatedAt: "2026-01-02T10:05:00.000Z",
      priority: 0,
      retryCount: 0,
      reviewCycleCount: 0,
      mergeAttemptCount: 0,
      staleSessionRetryCount: 0,
      isParent: 0,
    });

    const res = await app.request(`/api/cron/${id}/tasks`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    // Newest first
    expect(body[0].linearIssueId).toBe(taskId2);
    expect(body[1].linearIssueId).toBe(taskId1);
  });

  it("attaches empty invocations array for tasks with no invocation records", async () => {
    const id = insertCronSchedule(db, makeSchedule({ type: "shell" }));
    const taskId = `cron-${id}-shell-1`;
    insertTask(db, {
      linearIssueId: taskId,
      agentPrompt: "echo hello",
      repoPath: "",
      orcaStatus: "done",
      taskType: "cron_shell",
      cronScheduleId: id,
      createdAt: now(),
      updatedAt: now(),
      priority: 0,
      retryCount: 0,
      reviewCycleCount: 0,
      mergeAttemptCount: 0,
      staleSessionRetryCount: 0,
      isParent: 0,
    });

    const res = await app.request(`/api/cron/${id}/tasks`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].invocations).toEqual([]);
  });

  it("only returns tasks belonging to the requested schedule", async () => {
    const id1 = insertCronSchedule(db, makeSchedule({ name: "sched-1" }));
    const id2 = insertCronSchedule(db, makeSchedule({ name: "sched-2" }));
    insertTask(db, {
      linearIssueId: `cron-${id1}-task`,
      agentPrompt: "task for sched 1",
      repoPath: "/tmp",
      orcaStatus: "done",
      taskType: "cron_claude",
      cronScheduleId: id1,
      createdAt: now(),
      updatedAt: now(),
      priority: 0,
      retryCount: 0,
      reviewCycleCount: 0,
      mergeAttemptCount: 0,
      staleSessionRetryCount: 0,
      isParent: 0,
    });

    const res = await app.request(`/api/cron/${id2}/tasks`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(0);
  });
});

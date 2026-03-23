// ---------------------------------------------------------------------------
// Alerts tests — sendPermanentFailureAlert behavior
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  insertInvocation,
  getRecentSystemEvents,
  insertSystemEvent,
} from "../src/db/queries.js";
import type { OrcaConfig } from "../src/config/index.js";
import {
  sendPermanentFailureAlert,
  sendAlert,
  sendAlertThrottled,
  trackHealingAttempt,
  initAlertSystem,
  _getHealingCounters,
  _getAlertCooldowns,
  type AlertPayload,
} from "../src/scheduler/alerts.js";

/** Test-only helper: clears all healing counters and alert cooldowns. */
function resetHealingCounters(): void {
  _getHealingCounters().clear();
  _getAlertCooldowns().clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): OrcaDb {
  return createDb(":memory:");
}

function now(): string {
  return new Date().toISOString();
}

let taskCounter = 0;

function seedTask(db: OrcaDb, id?: string): string {
  const taskId = id ?? `ALERT-${++taskCounter}-${Date.now().toString(36)}`;
  const ts = now();
  insertTask(db, {
    linearIssueId: taskId,
    agentPrompt: "implement the feature",
    repoPath: "/tmp/fake-repo",
    orcaStatus: "failed",
    priority: 0,
    retryCount: 3,
    prBranchName: null,
    reviewCycleCount: 0,
    isParent: 0,
    parentIdentifier: null,
    mergeCommitSha: null,
    prNumber: null,
    deployStartedAt: null,
    ciStartedAt: null,
    fixReason: null,
    mergeAttemptCount: 0,
    doneAt: null,
    projectName: null,
    createdAt: ts,
    updatedAt: ts,
  });
  return taskId;
}

function testConfig(overrides: Partial<OrcaConfig> = {}): OrcaConfig {
  return {
    defaultCwd: "/tmp/test",
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
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-webhook-secret",
    linearProjectIds: ["proj-1"],
    tunnelHostname: "test.example.com",
    alertWebhookUrl: undefined,
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    externalTunnel: false,
    logLevel: "info",
    projectRepoMap: new Map(),
    ...overrides,
  };
}

function makeDeps(db: OrcaDb, config: OrcaConfig = testConfig()) {
  return {
    db,
    config,
    graph: {
      isDispatchable: vi.fn().mockReturnValue(true),
      computeEffectivePriority: vi.fn(),
      rebuild: vi.fn(),
    } as any,
    client: {
      createComment: vi.fn().mockResolvedValue(undefined),
      createAttachment: vi.fn().mockResolvedValue(undefined),
    } as any,
    stateMap: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sendPermanentFailureAlert", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.restoreAllMocks();
  });

  test("posts a rich Linear comment with task ID, reason, retry count, and invocation IDs", async () => {
    const taskId = seedTask(db);
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
      phase: "implement",
      model: "sonnet",
    });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
      phase: "implement",
      model: "sonnet",
    });

    const deps = makeDeps(db);
    sendPermanentFailureAlert(deps, taskId, "something went wrong");

    // Allow the promise chain to resolve
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(deps.client.createComment).toHaveBeenCalledOnce();
    const [calledTaskId, calledComment] = (
      deps.client.createComment as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(calledTaskId).toBe(taskId);
    expect(calledComment).toContain("**Task permanently failed**");
    expect(calledComment).toContain("**Reason:** something went wrong");
    expect(calledComment).toContain("**Retry count:** 3/3");
    expect(calledComment).toContain("**Invocations:**");
    // Should contain invocation IDs (1 and 2)
    expect(calledComment).toMatch(/\d+/);
  });

  test("does NOT send webhook when alertWebhookUrl is undefined", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const taskId = seedTask(db);
    const deps = makeDeps(db, testConfig({ alertWebhookUrl: undefined }));
    sendPermanentFailureAlert(deps, taskId, "some reason");

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("sends webhook with correct Slack/Discord payload when alertWebhookUrl is set", async () => {
    const mockResponse = { ok: true, status: 200 };
    const fetchMock = vi.fn().mockResolvedValue(mockResponse);
    vi.stubGlobal("fetch", fetchMock);

    const taskId = seedTask(db);
    const config = testConfig({
      alertWebhookUrl: "https://hooks.example.com/webhook",
    });
    const deps = makeDeps(db, config);
    sendPermanentFailureAlert(deps, taskId, "deploy timed out after 30min");

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/webhook");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(options.body);
    expect(body.text).toContain("Permanent Task Failure");
    expect(body.text).toContain("critical");
    expect(body.attachments).toHaveLength(1);
    const attachment = body.attachments[0];
    expect(attachment.color).toBe("danger");
    expect(attachment.title).toBe("Permanent Task Failure");

    const fields = attachment.fields;
    expect(
      fields.find((f: { title: string }) => f.title === "Task ID").value,
    ).toBe(taskId);
    expect(
      fields.find((f: { title: string }) => f.title === "Reason").value,
    ).toBe("deploy timed out after 30min");
    expect(
      fields.find((f: { title: string }) => f.title === "Retry count").value,
    ).toBe("3/3");
  });

  test("swallows comment errors (fire-and-forget)", async () => {
    const taskId = seedTask(db);
    const deps = makeDeps(db);
    (deps.client.createComment as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network error"),
    );

    // Should not throw
    expect(() =>
      sendPermanentFailureAlert(deps, taskId, "reason"),
    ).not.toThrow();

    // Give the rejected promise time to settle without blowing up
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  });

  test("swallows webhook errors (fire-and-forget)", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchMock);

    const taskId = seedTask(db);
    const config = testConfig({
      alertWebhookUrl: "https://hooks.example.com/webhook",
    });
    const deps = makeDeps(db, config);

    expect(() =>
      sendPermanentFailureAlert(deps, taskId, "reason"),
    ).not.toThrow();

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  });

  test("works correctly when task has no invocations", async () => {
    const taskId = seedTask(db);
    const deps = makeDeps(db);
    sendPermanentFailureAlert(deps, taskId, "immediate failure");

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(deps.client.createComment).toHaveBeenCalledOnce();
    const [, calledComment] = (
      deps.client.createComment as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(calledComment).toContain("**Invocations:** none");
  });

  test("webhook non-OK response is logged but does not throw", async () => {
    const mockResponse = { ok: false, status: 500 };
    const fetchMock = vi.fn().mockResolvedValue(mockResponse);
    vi.stubGlobal("fetch", fetchMock);

    const taskId = seedTask(db);
    const config = testConfig({
      alertWebhookUrl: "https://hooks.example.com/webhook",
    });
    const deps = makeDeps(db, config);

    expect(() =>
      sendPermanentFailureAlert(deps, taskId, "reason"),
    ).not.toThrow();

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// sendAlert
// ---------------------------------------------------------------------------

describe("sendAlert", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.restoreAllMocks();
  });

  const basePayload: AlertPayload = {
    severity: "warning",
    title: "Test Alert",
    message: "Something happened",
  };

  test("inserts system event with type self_heal", () => {
    const deps = makeDeps(db);
    sendAlert(deps, basePayload);

    const events = getRecentSystemEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("self_heal");
    expect(events[0].message).toContain("[warning]");
    expect(events[0].message).toContain("Test Alert");
  });

  test("posts Linear comment when taskId is set", async () => {
    const deps = makeDeps(db);
    sendAlert(deps, { ...basePayload, taskId: "TASK-1" });

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(deps.client.createComment).toHaveBeenCalledOnce();
    const [calledTaskId, calledComment] = (
      deps.client.createComment as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(calledTaskId).toBe("TASK-1");
    expect(calledComment).toContain("Test Alert");
  });

  test("fires webhook when alertWebhookUrl is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const config = testConfig({
      alertWebhookUrl: "https://hooks.example.com/test",
    });
    const deps = makeDeps(db, config);
    sendAlert(deps, basePayload);

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/test");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(options.body);
    expect(body.text).toContain("Test Alert");
    expect(body.attachments[0].title).toBe("Test Alert");
  });

  test("never throws even when DB insert fails", () => {
    const deps = makeDeps(db);
    deps.db = {} as any; // Force DB error
    expect(() => sendAlert(deps, basePayload)).not.toThrow();
  });

  test("never throws even when webhook fails", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchMock);

    const config = testConfig({
      alertWebhookUrl: "https://hooks.example.com/fail",
    });
    const deps = makeDeps(db, config);

    expect(() => sendAlert(deps, basePayload)).not.toThrow();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  });

  test("never throws even when Linear comment fails", async () => {
    const deps = makeDeps(db);
    (deps.client.createComment as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        throw new Error("sync error");
      },
    );

    expect(() =>
      sendAlert(deps, { ...basePayload, taskId: "TASK-ERR" }),
    ).not.toThrow();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  });

  test("maps severity to correct webhook color", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const config = testConfig({
      alertWebhookUrl: "https://hooks.example.com/color",
    });
    const deps = makeDeps(db, config);

    const expected: Record<string, string> = {
      info: "#36a64f",
      warning: "warning",
      critical: "danger",
    };

    for (const [severity, color] of Object.entries(expected)) {
      fetchMock.mockClear();
      sendAlert(deps, {
        ...basePayload,
        severity: severity as AlertPayload["severity"],
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.attachments[0].color).toBe(color);
    }
  });
});

// ---------------------------------------------------------------------------
// sendAlertThrottled
// ---------------------------------------------------------------------------

describe("sendAlertThrottled", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.restoreAllMocks();
    resetHealingCounters(); // also clears alertCooldowns
  });

  const payload: AlertPayload = {
    severity: "warning",
    title: "Throttle Test",
    message: "msg",
  };

  test("deduplicates within cooldown window", () => {
    const deps = makeDeps(db);
    sendAlertThrottled(deps, "dup-key", payload, 60_000);
    sendAlertThrottled(deps, "dup-key", payload, 60_000);

    const events = getRecentSystemEvents(db);
    expect(events).toHaveLength(1);
  });

  test("allows after cooldown expires", () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps(db);
      sendAlertThrottled(deps, "expire-key", payload, 5_000);

      let events = getRecentSystemEvents(db);
      expect(events).toHaveLength(1);

      vi.advanceTimersByTime(6_000);

      sendAlertThrottled(deps, "expire-key", payload, 5_000);

      events = getRecentSystemEvents(db);
      expect(events).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// trackHealingAttempt
// ---------------------------------------------------------------------------

describe("trackHealingAttempt", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetHealingCounters();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("increments and returns count", () => {
    expect(trackHealingAttempt("inc-key")).toBe(1);
    expect(trackHealingAttempt("inc-key")).toBe(2);
    expect(trackHealingAttempt("inc-key")).toBe(3);
  });

  test("resets after 1h inactivity", () => {
    vi.useFakeTimers();
    trackHealingAttempt("stale-key");
    expect(_getHealingCounters().get("stale-key")?.count).toBe(1);

    vi.advanceTimersByTime(3_600_001); // 1h + 1ms

    const result = trackHealingAttempt("stale-key");
    expect(result).toBe(1); // reset, so starts fresh
  });

  test("excludes events within 10 min of last startup", () => {
    const db = freshDb();
    insertSystemEvent(db, { type: "startup", message: "test startup" });
    initAlertSystem(db);

    // Startup just happened, so within 10 min grace period
    const result = trackHealingAttempt("grace-key");
    expect(result).toBe(0);

    // Clean up
    initAlertSystem(null as any); // reset cachedDb
  });

  test("counts normally after 10 min post-startup", () => {
    vi.useFakeTimers();
    const db = freshDb();

    // Insert startup event "in the past" by advancing time after insert
    insertSystemEvent(db, { type: "startup", message: "old startup" });
    vi.advanceTimersByTime(600_001); // advance past 10 min grace

    initAlertSystem(db);

    const result = trackHealingAttempt("post-grace-key");
    expect(result).toBe(1);

    // Clean up
    initAlertSystem(null as any);
  });
});

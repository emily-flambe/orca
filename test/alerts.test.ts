// ---------------------------------------------------------------------------
// Alerts tests — sendPermanentFailureAlert behavior
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import { insertTask, insertInvocation } from "../src/db/queries.js";
import type { OrcaConfig } from "../src/config/index.js";
import { sendPermanentFailureAlert } from "../src/scheduler/alerts.js";

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
    budgetMaxCostUsd: 10.0,
    schedulerIntervalSec: 3600,
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
    cleanupIntervalMin: 10000,
    cleanupBranchMaxAgeMin: 60,
    resumeOnMaxTurns: true,
    resumeOnFix: true,
    port: 3000,
    dbPath: ":memory:",
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-webhook-secret",
    linearProjectIds: ["proj-1"],
    linearReadyStateType: "unstarted",
    tunnelHostname: "test.example.com",
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    projectRepoMap: new Map(),
    logPath: "./orca.log",
    logMaxSizeMb: 10,
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
    expect(body.text).toContain(taskId);
    expect(body.text).toContain("permanently failed");
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

// ---------------------------------------------------------------------------
// Tests for src/events.ts
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from "vitest";
import {
  orcaEvents,
  emitTaskUpdated,
  emitInvocationStarted,
  emitInvocationCompleted,
  emitTasksRefreshed,
} from "../src/events.js";
import type { Task } from "../src/db/queries.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  orcaEvents.removeAllListeners();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    linearIssueId: "TEST-1",
    agentPrompt: "Test task",
    repoPath: "/repo",
    orcaStatus: "ready",
    priority: 3,
    retryCount: 0,
    prBranchName: null,
    reviewCycleCount: 0,
    mergeCommitSha: null,
    prNumber: null,
    deployStartedAt: null,
    ciStartedAt: null,
    doneAt: null,
    projectName: null,
    invocationCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    taskType: "linear",
    cronScheduleId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("emitTaskUpdated", () => {
  test("fires task:updated event with the task payload", () => {
    const task = makeTask({ linearIssueId: "TEST-42" });
    let received: Task | null = null;

    orcaEvents.on("task:updated", (t: Task) => {
      received = t;
    });

    emitTaskUpdated(task);

    expect(received).toEqual(task);
  });
});

describe("emitInvocationStarted", () => {
  test("fires invocation:started event with correct payload", () => {
    const payload = { taskId: "TEST-1", invocationId: 99 };
    let received: typeof payload | null = null;

    orcaEvents.on("invocation:started", (p) => {
      received = p as typeof payload;
    });

    emitInvocationStarted(payload);

    expect(received).toEqual(payload);
  });
});

describe("emitInvocationCompleted", () => {
  test("fires invocation:completed event with correct payload", () => {
    const payload = {
      taskId: "TEST-1",
      invocationId: 5,
      status: "completed",
      costUsd: 0.05,
      inputTokens: 1000,
      outputTokens: 500,
    };
    let received: typeof payload | null = null;

    orcaEvents.on("invocation:completed", (p) => {
      received = p as typeof payload;
    });

    emitInvocationCompleted(payload);

    expect(received).toEqual(payload);
  });
});

describe("emitTasksRefreshed", () => {
  test("fires tasks:refreshed event with no payload", () => {
    let fired = false;

    orcaEvents.on("tasks:refreshed", () => {
      fired = true;
    });

    emitTasksRefreshed();

    expect(fired).toBe(true);
  });
});

describe("multiple listeners", () => {
  test("all listeners for the same event receive the payload", () => {
    const received: string[] = [];

    orcaEvents.on("tasks:refreshed", () => received.push("listener1"));
    orcaEvents.on("tasks:refreshed", () => received.push("listener2"));
    orcaEvents.on("tasks:refreshed", () => received.push("listener3"));

    emitTasksRefreshed();

    expect(received).toEqual(["listener1", "listener2", "listener3"]);
  });

  test("multiple task:updated listeners all receive the task", () => {
    const task = makeTask();
    const results: Task[] = [];

    orcaEvents.on("task:updated", (t: Task) => results.push(t));
    orcaEvents.on("task:updated", (t: Task) => results.push(t));

    emitTaskUpdated(task);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(task);
    expect(results[1]).toEqual(task);
  });
});

describe("orcaEvents singleton", () => {
  test("is the same reference across two imports", async () => {
    // Dynamic re-import should return the same cached module
    const mod1 = await import("../src/events.js");
    const mod2 = await import("../src/events.js");
    expect(mod1.orcaEvents).toBe(mod2.orcaEvents);
  });
});

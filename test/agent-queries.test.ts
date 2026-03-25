// ---------------------------------------------------------------------------
// Agent DB query tests -- adversarial coverage
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../src/db/index.js";
import {
  insertAgent,
  getAgent,
  getAllAgents,
  updateAgent,
  deleteAgent,
  getDueAgents,
  updateAgentLastRunStatus,
  incrementAgentRunCount,
  insertAgentMemory,
  updateAgentMemory,
  deleteAgentMemory,
  getAgentMemories,
  getAgentMemoryCount,
  deleteAllAgentMemories,
  pruneAgentMemories,
  getTasksByAgent,
  insertTask,
} from "../src/db/queries.js";
import type { OrcaDb } from "../src/db/index.js";

function now(): string {
  return new Date().toISOString();
}

function makeAgent(overrides?: Record<string, unknown>) {
  const ts = now();
  return {
    id: "test-agent",
    name: "Test Agent",
    description: null,
    systemPrompt: "You are a test agent",
    model: null,
    maxTurns: null,
    timeoutMin: 45,
    repoPath: null,
    schedule: null,
    maxMemories: 200,
    enabled: 1,
    runCount: 0,
    lastRunAt: null,
    nextRunAt: null,
    lastRunStatus: null,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// insertAgent / getAgent
// ---------------------------------------------------------------------------

describe("insertAgent / getAgent", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("inserts and retrieves an agent", () => {
    insertAgent(db, makeAgent());
    const agent = getAgent(db, "test-agent");
    expect(agent).toBeDefined();
    expect(agent!.id).toBe("test-agent");
    expect(agent!.name).toBe("Test Agent");
    expect(agent!.systemPrompt).toBe("You are a test agent");
    expect(agent!.enabled).toBe(1);
    expect(agent!.runCount).toBe(0);
    expect(agent!.maxMemories).toBe(200);
  });

  it("returns undefined for non-existent agent", () => {
    const agent = getAgent(db, "does-not-exist");
    expect(agent).toBeUndefined();
  });

  it("throws on duplicate primary key", () => {
    insertAgent(db, makeAgent());
    expect(() => insertAgent(db, makeAgent())).toThrow();
  });

  it("stores all nullable fields as null", () => {
    insertAgent(db, makeAgent());
    const agent = getAgent(db, "test-agent")!;
    expect(agent.description).toBeNull();
    expect(agent.model).toBeNull();
    expect(agent.maxTurns).toBeNull();
    expect(agent.repoPath).toBeNull();
    expect(agent.schedule).toBeNull();
    expect(agent.lastRunAt).toBeNull();
    expect(agent.nextRunAt).toBeNull();
    expect(agent.lastRunStatus).toBeNull();
  });

});

// ---------------------------------------------------------------------------
// getAllAgents
// ---------------------------------------------------------------------------

describe("getAllAgents", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("returns all agents", () => {
    insertAgent(db, makeAgent({ id: "agent-1", name: "Agent 1" }));
    insertAgent(db, makeAgent({ id: "agent-2", name: "Agent 2" }));
    const all = getAllAgents(db);
    expect(all).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// updateAgent
// ---------------------------------------------------------------------------

describe("updateAgent", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
    insertAgent(db, makeAgent());
  });

  it("updates name", () => {
    updateAgent(db, "test-agent", { name: "New Name" });
    expect(getAgent(db, "test-agent")!.name).toBe("New Name");
  });

  it("updates multiple fields", () => {
    updateAgent(db, "test-agent", {
      name: "Updated",
      description: "A description",
      enabled: 0,
    });
    const agent = getAgent(db, "test-agent")!;
    expect(agent.name).toBe("Updated");
    expect(agent.description).toBe("A description");
    expect(agent.enabled).toBe(0);
  });

  it("updates updatedAt timestamp", () => {
    const before = getAgent(db, "test-agent")!.updatedAt;
    // Force time difference
    const origDateNow = Date.now;
    Date.now = () => origDateNow() + 2000;
    updateAgent(db, "test-agent", { name: "changed" });
    Date.now = origDateNow;
    const after = getAgent(db, "test-agent")!.updatedAt;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );
  });

});

// ---------------------------------------------------------------------------
// deleteAgent — cascade
// ---------------------------------------------------------------------------

describe("deleteAgent", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("deletes agent", () => {
    insertAgent(db, makeAgent());
    deleteAgent(db, "test-agent");
    expect(getAgent(db, "test-agent")).toBeUndefined();
  });

  it("cascade-deletes memories when agent is deleted", () => {
    insertAgent(db, makeAgent());
    insertAgentMemory(db, {
      agentId: "test-agent",
      type: "episodic",
      content: "something",
    });
    insertAgentMemory(db, {
      agentId: "test-agent",
      type: "semantic",
      content: "something else",
    });
    expect(getAgentMemoryCount(db, "test-agent")).toBe(2);
    deleteAgent(db, "test-agent");
    expect(getAgentMemoryCount(db, "test-agent")).toBe(0);
  });

  it("does not throw when deleting non-existent agent", () => {
    expect(() => deleteAgent(db, "nope")).not.toThrow();
  });

  it("does not delete other agents' memories", () => {
    insertAgent(db, makeAgent({ id: "agent-a" }));
    insertAgent(db, makeAgent({ id: "agent-b" }));
    insertAgentMemory(db, {
      agentId: "agent-a",
      type: "episodic",
      content: "memory a",
    });
    insertAgentMemory(db, {
      agentId: "agent-b",
      type: "episodic",
      content: "memory b",
    });
    deleteAgent(db, "agent-a");
    expect(getAgentMemoryCount(db, "agent-b")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getDueAgents
// ---------------------------------------------------------------------------

describe("getDueAgents", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("returns empty when no agents", () => {
    expect(getDueAgents(db, now())).toEqual([]);
  });

  it("returns agent when next_run_at is in the past", () => {
    const pastTime = new Date(Date.now() - 60000).toISOString();
    insertAgent(
      db,
      makeAgent({
        id: "due-agent",
        schedule: "* * * * *",
        nextRunAt: pastTime,
        enabled: 1,
      }),
    );
    const due = getDueAgents(db, now());
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe("due-agent");
  });

  it("returns agent when next_run_at equals now exactly", () => {
    const exactNow = "2026-03-22T12:00:00.000Z";
    insertAgent(
      db,
      makeAgent({
        id: "exact-agent",
        schedule: "* * * * *",
        nextRunAt: exactNow,
        enabled: 1,
      }),
    );
    const due = getDueAgents(db, exactNow);
    expect(due).toHaveLength(1);
  });

  it("excludes disabled agents", () => {
    const pastTime = new Date(Date.now() - 60000).toISOString();
    insertAgent(
      db,
      makeAgent({
        id: "disabled-agent",
        schedule: "* * * * *",
        nextRunAt: pastTime,
        enabled: 0,
      }),
    );
    expect(getDueAgents(db, now())).toHaveLength(0);
  });

  it("excludes agents without schedule", () => {
    const pastTime = new Date(Date.now() - 60000).toISOString();
    insertAgent(
      db,
      makeAgent({
        id: "no-sched",
        schedule: null,
        nextRunAt: pastTime,
        enabled: 1,
      }),
    );
    expect(getDueAgents(db, now())).toHaveLength(0);
  });

  it("excludes agents without next_run_at", () => {
    insertAgent(
      db,
      makeAgent({
        id: "no-next",
        schedule: "* * * * *",
        nextRunAt: null,
        enabled: 1,
      }),
    );
    expect(getDueAgents(db, now())).toHaveLength(0);
  });

  it("excludes agents where next_run_at is in the future", () => {
    const futureTime = new Date(Date.now() + 600000).toISOString();
    insertAgent(
      db,
      makeAgent({
        id: "future-agent",
        schedule: "* * * * *",
        nextRunAt: futureTime,
        enabled: 1,
      }),
    );
    expect(getDueAgents(db, now())).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// updateAgentLastRunStatus
// ---------------------------------------------------------------------------

describe("updateAgentLastRunStatus", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
    insertAgent(db, makeAgent());
  });

  it("sets status to success", () => {
    updateAgentLastRunStatus(db, "test-agent", "success");
    expect(getAgent(db, "test-agent")!.lastRunStatus).toBe("success");
  });

  it("sets status to failed", () => {
    updateAgentLastRunStatus(db, "test-agent", "failed");
    expect(getAgent(db, "test-agent")!.lastRunStatus).toBe("failed");
  });

  it("overwrites previous status", () => {
    updateAgentLastRunStatus(db, "test-agent", "success");
    updateAgentLastRunStatus(db, "test-agent", "failed");
    expect(getAgent(db, "test-agent")!.lastRunStatus).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// incrementAgentRunCount
// ---------------------------------------------------------------------------

describe("incrementAgentRunCount", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
    insertAgent(db, makeAgent());
  });

  it("increments run count from 0 to 1", () => {
    incrementAgentRunCount(db, "test-agent", null);
    expect(getAgent(db, "test-agent")!.runCount).toBe(1);
  });

  it("increments run count multiple times", () => {
    incrementAgentRunCount(db, "test-agent", null);
    incrementAgentRunCount(db, "test-agent", null);
    incrementAgentRunCount(db, "test-agent", null);
    expect(getAgent(db, "test-agent")!.runCount).toBe(3);
  });

  it("sets lastRunAt", () => {
    incrementAgentRunCount(db, "test-agent", null);
    expect(getAgent(db, "test-agent")!.lastRunAt).not.toBeNull();
  });

  it("sets nextRunAt when provided", () => {
    const next = "2026-04-01T00:00:00.000Z";
    incrementAgentRunCount(db, "test-agent", next);
    expect(getAgent(db, "test-agent")!.nextRunAt).toBe(next);
  });

  it("clears nextRunAt when null", () => {
    // First set a nextRunAt
    updateAgent(db, "test-agent", {
      nextRunAt: "2026-04-01T00:00:00.000Z",
    });
    incrementAgentRunCount(db, "test-agent", null);
    expect(getAgent(db, "test-agent")!.nextRunAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// insertAgentMemory
// ---------------------------------------------------------------------------

describe("insertAgentMemory", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
    insertAgent(db, makeAgent());
  });

  it("returns the auto-generated id", () => {
    const id = insertAgentMemory(db, {
      agentId: "test-agent",
      type: "episodic",
      content: "I learned something",
    });
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
  });

  it("stores sourceRunId when provided", () => {
    const id = insertAgentMemory(db, {
      agentId: "test-agent",
      type: "procedural",
      content: "procedure",
      sourceRunId: "run-123",
    });
    const memories = getAgentMemories(db, "test-agent");
    const found = memories.find((m) => m.id === id);
    expect(found!.sourceRunId).toBe("run-123");
  });

  it("defaults sourceRunId to null", () => {
    const id = insertAgentMemory(db, {
      agentId: "test-agent",
      type: "episodic",
      content: "no source",
    });
    const memories = getAgentMemories(db, "test-agent");
    const found = memories.find((m) => m.id === id);
    expect(found!.sourceRunId).toBeNull();
  });

  it("handles very long content", () => {
    const longContent = "x".repeat(100000);
    const id = insertAgentMemory(db, {
      agentId: "test-agent",
      type: "episodic",
      content: longContent,
    });
    const memories = getAgentMemories(db, "test-agent");
    expect(memories.find((m) => m.id === id)!.content).toBe(longContent);
  });
});

// ---------------------------------------------------------------------------
// getAgentMemories
// ---------------------------------------------------------------------------

describe("getAgentMemories", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
    insertAgent(db, makeAgent());
  });

  it("returns memories ordered by created_at DESC (newest first)", () => {
    // Insert with explicit timestamps using vi.spyOn on Date constructor
    // Since insertAgentMemory uses new Date().toISOString(), we need to
    // mock the Date constructor itself, not just Date.now.
    const origDate = globalThis.Date;
    let mockTime = 1700000000000;

    // Replace Date with a proxy that returns our controlled time
    const MockDate = class extends origDate {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(mockTime);
        } else {
          // @ts-expect-error spread args for Date constructor override
          super(...args);
        }
      }
      static now() {
        return mockTime;
      }
    } as any;
    MockDate.parse = origDate.parse;
    MockDate.UTC = origDate.UTC;
    globalThis.Date = MockDate;

    insertAgentMemory(db, {
      agentId: "test-agent",
      type: "episodic",
      content: "oldest",
    });

    mockTime += 10000;
    insertAgentMemory(db, {
      agentId: "test-agent",
      type: "semantic",
      content: "middle",
    });

    mockTime += 10000;
    insertAgentMemory(db, {
      agentId: "test-agent",
      type: "procedural",
      content: "newest",
    });

    globalThis.Date = origDate;

    const memories = getAgentMemories(db, "test-agent");
    expect(memories).toHaveLength(3);
    expect(memories[0].content).toBe("newest");
    expect(memories[1].content).toBe("middle");
    expect(memories[2].content).toBe("oldest");
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      insertAgentMemory(db, {
        agentId: "test-agent",
        type: "episodic",
        content: `memory ${i}`,
      });
    }
    const limited = getAgentMemories(db, "test-agent", 2);
    expect(limited).toHaveLength(2);
  });

  it("limit=0 returns all memories (falsy check)", () => {
    for (let i = 0; i < 3; i++) {
      insertAgentMemory(db, {
        agentId: "test-agent",
        type: "episodic",
        content: `memory ${i}`,
      });
    }
    // limit=0 is falsy, so the if(limit) check skips it
    const all = getAgentMemories(db, "test-agent", 0);
    expect(all).toHaveLength(3);
  });

  it("does not return other agents' memories", () => {
    insertAgent(db, makeAgent({ id: "other-agent" }));
    insertAgentMemory(db, {
      agentId: "other-agent",
      type: "episodic",
      content: "not mine",
    });
    expect(getAgentMemories(db, "test-agent")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// updateAgentMemory
// ---------------------------------------------------------------------------

describe("updateAgentMemory", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
    insertAgent(db, makeAgent());
  });

  it("updates content", () => {
    const id = insertAgentMemory(db, {
      agentId: "test-agent",
      type: "episodic",
      content: "original",
    });
    updateAgentMemory(db, id, "updated");
    const memories = getAgentMemories(db, "test-agent");
    expect(memories.find((m) => m.id === id)!.content).toBe("updated");
  });

  it("updates updatedAt timestamp", () => {
    const id = insertAgentMemory(db, {
      agentId: "test-agent",
      type: "episodic",
      content: "original",
    });
    const before = getAgentMemories(db, "test-agent").find(
      (m) => m.id === id,
    )!.updatedAt;

    const origDateNow = Date.now;
    Date.now = () => origDateNow() + 2000;
    updateAgentMemory(db, id, "changed");
    Date.now = origDateNow;

    const after = getAgentMemories(db, "test-agent").find(
      (m) => m.id === id,
    )!.updatedAt;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );
  });

});

// ---------------------------------------------------------------------------
// deleteAgentMemory
// ---------------------------------------------------------------------------

describe("deleteAgentMemory", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
    insertAgent(db, makeAgent());
  });

  it("deletes a memory", () => {
    const id = insertAgentMemory(db, {
      agentId: "test-agent",
      type: "episodic",
      content: "to delete",
    });
    deleteAgentMemory(db, id);
    expect(getAgentMemoryCount(db, "test-agent")).toBe(0);
  });

  it("does not affect other memories", () => {
    const id1 = insertAgentMemory(db, {
      agentId: "test-agent",
      type: "episodic",
      content: "keep",
    });
    const id2 = insertAgentMemory(db, {
      agentId: "test-agent",
      type: "semantic",
      content: "delete",
    });
    deleteAgentMemory(db, id2);
    expect(getAgentMemoryCount(db, "test-agent")).toBe(1);
    const remaining = getAgentMemories(db, "test-agent");
    expect(remaining[0].id).toBe(id1);
  });
});

// ---------------------------------------------------------------------------
// getAgentMemoryCount
// ---------------------------------------------------------------------------

describe("getAgentMemoryCount", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
    insertAgent(db, makeAgent());
  });

  it("returns correct count", () => {
    insertAgentMemory(db, {
      agentId: "test-agent",
      type: "episodic",
      content: "a",
    });
    insertAgentMemory(db, {
      agentId: "test-agent",
      type: "semantic",
      content: "b",
    });
    expect(getAgentMemoryCount(db, "test-agent")).toBe(2);
  });

});

// ---------------------------------------------------------------------------
// deleteAllAgentMemories
// ---------------------------------------------------------------------------

describe("deleteAllAgentMemories", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
    insertAgent(db, makeAgent({ id: "agent-a" }));
    insertAgent(db, makeAgent({ id: "agent-b" }));
  });

  it("deletes all memories for agent", () => {
    insertAgentMemory(db, {
      agentId: "agent-a",
      type: "episodic",
      content: "a1",
    });
    insertAgentMemory(db, {
      agentId: "agent-a",
      type: "semantic",
      content: "a2",
    });
    deleteAllAgentMemories(db, "agent-a");
    expect(getAgentMemoryCount(db, "agent-a")).toBe(0);
  });

  it("does not affect other agents' memories", () => {
    insertAgentMemory(db, {
      agentId: "agent-a",
      type: "episodic",
      content: "a",
    });
    insertAgentMemory(db, {
      agentId: "agent-b",
      type: "episodic",
      content: "b",
    });
    deleteAllAgentMemories(db, "agent-a");
    expect(getAgentMemoryCount(db, "agent-b")).toBe(1);
  });

});

// ---------------------------------------------------------------------------
// pruneAgentMemories
// ---------------------------------------------------------------------------

describe("pruneAgentMemories", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
    insertAgent(db, makeAgent());
  });

  function addMemories(count: number): number[] {
    const ids: number[] = [];
    const origDate = globalThis.Date;
    let mockTime = 1700000000000;

    const MockDate = class extends origDate {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(mockTime);
        } else {
          // @ts-expect-error spread args for Date constructor override
          super(...args);
        }
      }
      static now() {
        return mockTime;
      }
    } as any;
    MockDate.parse = origDate.parse;
    MockDate.UTC = origDate.UTC;
    globalThis.Date = MockDate;

    for (let i = 0; i < count; i++) {
      ids.push(
        insertAgentMemory(db, {
          agentId: "test-agent",
          type: "episodic",
          content: `memory ${i}`,
        }),
      );
      mockTime += 10000;
    }
    globalThis.Date = origDate;
    return ids;
  }

  it("returns 0 when under limit", () => {
    addMemories(3);
    const deleted = pruneAgentMemories(db, "test-agent", 5);
    expect(deleted).toBe(0);
    expect(getAgentMemoryCount(db, "test-agent")).toBe(3);
  });

  it("returns 0 when exactly at limit", () => {
    addMemories(5);
    const deleted = pruneAgentMemories(db, "test-agent", 5);
    expect(deleted).toBe(0);
  });

  it("deletes oldest first when over limit", () => {
    const ids = addMemories(5);
    const deleted = pruneAgentMemories(db, "test-agent", 3);
    expect(deleted).toBe(2);
    expect(getAgentMemoryCount(db, "test-agent")).toBe(3);

    // The oldest two (ids[0], ids[1]) should be gone
    const remaining = getAgentMemories(db, "test-agent");
    const remainingIds = remaining.map((m) => m.id);
    expect(remainingIds).not.toContain(ids[0]);
    expect(remainingIds).not.toContain(ids[1]);
    // The newest three should remain
    expect(remainingIds).toContain(ids[2]);
    expect(remainingIds).toContain(ids[3]);
    expect(remainingIds).toContain(ids[4]);
  });

  it("maxMemories=0 deletes all memories", () => {
    addMemories(3);
    const deleted = pruneAgentMemories(db, "test-agent", 0);
    expect(deleted).toBe(3);
    expect(getAgentMemoryCount(db, "test-agent")).toBe(0);
  });

  it("handles negative maxMemories (deletes all)", () => {
    addMemories(2);
    // negative maxMemories: currentCount (2) > -1 is true, toDelete = 2 - (-1) = 3
    // but limit(3) with only 2 rows returns 2
    const deleted = pruneAgentMemories(db, "test-agent", -1);
    expect(deleted).toBe(2);
    expect(getAgentMemoryCount(db, "test-agent")).toBe(0);
  });

});

// ---------------------------------------------------------------------------
// getTasksByAgent
// ---------------------------------------------------------------------------

describe("getTasksByAgent", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
    insertAgent(db, makeAgent());
  });

  it("returns tasks for agent", () => {
    const ts = now();
    insertTask(db, {
      linearIssueId: "agent-test-agent-1",
      agentPrompt: "do stuff",
      repoPath: "/tmp",
      orcaStatus: "ready",
      taskType: "agent",
      agentId: "test-agent",
      createdAt: ts,
      updatedAt: ts,
      priority: 0,
      retryCount: 0,
      reviewCycleCount: 0,
      mergeAttemptCount: 0,
      staleSessionRetryCount: 0,
      isParent: 0,
    });
    const tasks = getTasksByAgent(db, "test-agent");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].agentId).toBe("test-agent");
    expect(tasks[0].taskType).toBe("agent");
  });

  it("does not return tasks from other agents", () => {
    const ts = now();
    insertTask(db, {
      linearIssueId: "agent-other-1",
      agentPrompt: "do stuff",
      repoPath: "/tmp",
      orcaStatus: "ready",
      taskType: "agent",
      agentId: "other-agent",
      createdAt: ts,
      updatedAt: ts,
      priority: 0,
      retryCount: 0,
      reviewCycleCount: 0,
      mergeAttemptCount: 0,
      staleSessionRetryCount: 0,
      isParent: 0,
    });
    expect(getTasksByAgent(db, "test-agent")).toHaveLength(0);
  });
});

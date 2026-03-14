import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockedFunction,
} from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock the Inngest client before importing runner (vi.mock is hoisted).
vi.mock("../src/inngest/client.js", () => ({
  inngest: { send: vi.fn().mockResolvedValue(undefined) },
}));

import { inngest } from "../src/inngest/client.js";
import { spawnSession } from "../src/runner/index.js";

const sendMock = inngest.send as MockedFunction<typeof inngest.send>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let invocationCounter = 20000;
function nextId(): number {
  return ++invocationCounter;
}

function makeScript(lines: string[]): string {
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Inngest event emission", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-inngest-test-"));
    sendMock.mockClear();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("emits session/completed for a successful session", async () => {
    const script = join(tmpDir, "success.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"sid-abc"}) + "\\n");',
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0.05,num_turns:3,result:"done",usage:{input_tokens:100,output_tokens:50}}) + "\\n");',
      ]),
    );

    const id = nextId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 10,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      linearIssueId: "LIN-123",
      phase: "implement",
    });

    await handle.done;

    expect(sendMock).toHaveBeenCalledOnce();
    const call = sendMock.mock.calls[0][0] as { name: string; data: unknown };
    expect(call.name).toBe("session/completed");

    const data = call.data as Record<string, unknown>;
    expect(data.invocationId).toBe(id);
    expect(data.linearIssueId).toBe("LIN-123");
    expect(data.phase).toBe("implement");
    expect(data.exitCode).toBe(0);
    expect(data.summary).toContain("done");
    expect(data.costUsd).toBeCloseTo(0.05);
    expect(data.inputTokens).toBe(100);
    expect(data.outputTokens).toBe(50);
    expect(data.numTurns).toBe(3);
    expect(data.sessionId).toBe("sid-abc");
    expect(data.status).toBe("completed");
    expect(typeof data.durationMs).toBe("number");
  });

  test("emits session/failed for error_max_turns", async () => {
    const script = join(tmpDir, "max-turns.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"result",subtype:"error_max_turns",total_cost_usd:0.01,num_turns:10}) + "\\n");',
      ]),
    );

    const id = nextId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 10,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      linearIssueId: "LIN-456",
      phase: "fix",
    });

    await handle.done;

    expect(sendMock).toHaveBeenCalledOnce();
    const call = sendMock.mock.calls[0][0] as { name: string; data: unknown };
    expect(call.name).toBe("session/failed");

    const data = call.data as Record<string, unknown>;
    expect(data.invocationId).toBe(id);
    expect(data.linearIssueId).toBe("LIN-456");
    expect(data.phase).toBe("fix");
    expect(data.errorSubtype).toBe("error_max_turns");
    expect(data.summary).toBe("max turns reached");
    expect(data.status).toBe("timed_out");
  });

  test("emits session/failed for process_error (non-zero exit)", async () => {
    const script = join(tmpDir, "proc-error.js");
    writeFileSync(
      script,
      makeScript([
        // No result message, exit non-zero
        "process.exit(1);",
      ]),
    );

    const id = nextId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 10,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      linearIssueId: "LIN-789",
      phase: "review",
    });

    await handle.done;

    expect(sendMock).toHaveBeenCalledOnce();
    const call = sendMock.mock.calls[0][0] as { name: string; data: unknown };
    expect(call.name).toBe("session/failed");

    const data = call.data as Record<string, unknown>;
    expect(data.errorSubtype).toBe("process_error");
    expect(data.exitCode).toBe(1);
    expect(data.linearIssueId).toBe("LIN-789");
    expect(data.phase).toBe("review");
    expect(data.status).toBe("failed");
  });

  test("emits session/failed for rate_limited", async () => {
    const script = join(tmpDir, "rate-limited.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"rate_limit_event",overageStatus:"rejected",rateLimitType:"daily",resetsAt:"2026-01-01T12:00:00Z"}) + "\\n");',
        "process.exit(1);",
      ]),
    );

    const id = nextId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 10,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      linearIssueId: "LIN-rate",
      phase: "implement",
    });

    await handle.done;

    expect(sendMock).toHaveBeenCalledOnce();
    const call = sendMock.mock.calls[0][0] as { name: string; data: unknown };
    expect(call.name).toBe("session/failed");

    const data = call.data as Record<string, unknown>;
    expect(data.errorSubtype).toBe("rate_limited");
    expect(data.status).toBe("failed");
  });

  test("defaults linearIssueId and phase to 'unknown' when not provided", async () => {
    const script = join(tmpDir, "defaults.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"ok"}) + "\\n");',
      ]),
    );

    const id = nextId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      // No linearIssueId or phase
    });

    await handle.done;

    expect(sendMock).toHaveBeenCalledOnce();
    const data = (
      sendMock.mock.calls[0][0] as {
        name: string;
        data: Record<string, unknown>;
      }
    ).data;
    expect(data.linearIssueId).toBe("unknown");
    expect(data.phase).toBe("unknown");
  });

  test("sessionId is null in event when no system/init was received", async () => {
    const script = join(tmpDir, "no-init.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"ok"}) + "\\n");',
      ]),
    );

    const id = nextId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      linearIssueId: "LIN-noinit",
      phase: "implement",
    });

    await handle.done;

    expect(sendMock).toHaveBeenCalledOnce();
    const data = (
      sendMock.mock.calls[0][0] as {
        name: string;
        data: Record<string, unknown>;
      }
    ).data;
    expect(data.sessionId).toBeNull();
  });
});

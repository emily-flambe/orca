// ---------------------------------------------------------------------------
// Tests for src/runner/shell.ts
// ---------------------------------------------------------------------------

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockSpawn, mockExecSync } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExecSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: mockSpawn,
    execSync: mockExecSync,
  };
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  mockSpawn.mockReset();
  mockExecSync.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  spawnShellCommand,
  activeShellHandles,
} from "../src/runner/shell.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChildProcess(overrides: {
  pid?: number;
  onClose?: (exitCode: number | null) => void;
}) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number | undefined;
    stdout: EventEmitter;
    stderr: EventEmitter;
    unref: () => void;
  };
  child.pid = overrides.pid ?? 12345;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = vi.fn();
  return child;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("spawnShellCommand", () => {
  test("registers handle in activeShellHandles when process starts", () => {
    const child = makeChildProcess({ pid: 100 });
    mockSpawn.mockReturnValue(child);

    const invocationId = 1;
    spawnShellCommand("echo hello", { timeoutMs: 10_000, invocationId });

    expect(activeShellHandles.has(invocationId)).toBe(true);

    // Cleanup
    activeShellHandles.delete(invocationId);
  });

  test("removes handle from activeShellHandles when process closes", async () => {
    const child = makeChildProcess({ pid: 101 });
    mockSpawn.mockReturnValue(child);

    const invocationId = 2;
    const handle = spawnShellCommand("echo hello", {
      timeoutMs: 10_000,
      invocationId,
    });

    expect(activeShellHandles.has(invocationId)).toBe(true);

    // Simulate process close
    child.emit("close", 0);

    await handle.done;

    expect(activeShellHandles.has(invocationId)).toBe(false);
  });

  test("done promise resolves with exitCode from close event", async () => {
    const child = makeChildProcess({ pid: 102 });
    mockSpawn.mockReturnValue(child);

    const handle = spawnShellCommand("some command", {
      timeoutMs: 10_000,
      invocationId: 3,
    });

    child.emit("close", 42);
    const result = await handle.done;

    expect(result.exitCode).toBe(42);
  });

  test("done promise resolves with combined stdout+stderr output", async () => {
    const child = makeChildProcess({ pid: 103 });
    mockSpawn.mockReturnValue(child);

    const handle = spawnShellCommand("some command", {
      timeoutMs: 10_000,
      invocationId: 4,
    });

    child.stdout.emit("data", Buffer.from("hello "));
    child.stderr.emit("data", Buffer.from("world"));
    child.emit("close", 0);

    const result = await handle.done;

    expect(result.output).toBe("hello world");
  });

  test("done promise resolves with timedOut: false on normal exit", async () => {
    const child = makeChildProcess({ pid: 104 });
    mockSpawn.mockReturnValue(child);

    const handle = spawnShellCommand("some command", {
      timeoutMs: 10_000,
      invocationId: 5,
    });

    child.emit("close", 0);
    const result = await handle.done;

    expect(result.timedOut).toBe(false);
  });

  test("on timeout, timedOut is true in result", async () => {
    const child = makeChildProcess({ pid: 105 });
    mockSpawn.mockReturnValue(child);

    // Use non-Windows mode: mock process.platform
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });

    const handle = spawnShellCommand("long command", {
      timeoutMs: 5_000,
      invocationId: 6,
    });

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(5_001);
    await Promise.resolve();

    // Simulate process dying after kill
    child.emit("close", null);

    const result = await handle.done;
    expect(result.timedOut).toBe(true);

    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  test("handle.kill() clears the timeout and kills the process", async () => {
    const child = makeChildProcess({ pid: 106 });
    mockSpawn.mockReturnValue(child);

    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });

    const handle = spawnShellCommand("some command", {
      timeoutMs: 30_000,
      invocationId: 7,
    });

    handle.kill();

    // Advance way past timeout — should NOT fire (timeout was cleared)
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.resolve();

    // Simulate process exits after kill
    child.emit("close", 0);
    const result = await handle.done;

    // timedOut should be false since we called kill() not the timeout
    expect(result.timedOut).toBe(false);

    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  test("spawn is called with shell: true", () => {
    const child = makeChildProcess({ pid: 107 });
    mockSpawn.mockReturnValue(child);

    spawnShellCommand("echo hi", { timeoutMs: 5_000, invocationId: 8 });

    expect(mockSpawn).toHaveBeenCalledWith(
      "echo hi",
      [],
      expect.objectContaining({ shell: true }),
    );

    // Cleanup
    activeShellHandles.delete(8);
  });

  test("done resolves with exitCode null when close event has null", async () => {
    const child = makeChildProcess({ pid: 108 });
    mockSpawn.mockReturnValue(child);

    const handle = spawnShellCommand("some command", {
      timeoutMs: 10_000,
      invocationId: 9,
    });

    child.emit("close", null);
    const result = await handle.done;

    expect(result.exitCode).toBeNull();
  });

  test("multiple handles can be tracked concurrently", () => {
    const child1 = makeChildProcess({ pid: 201 });
    const child2 = makeChildProcess({ pid: 202 });
    mockSpawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

    spawnShellCommand("cmd1", { timeoutMs: 10_000, invocationId: 10 });
    spawnShellCommand("cmd2", { timeoutMs: 10_000, invocationId: 11 });

    expect(activeShellHandles.has(10)).toBe(true);
    expect(activeShellHandles.has(11)).toBe(true);

    // Cleanup
    activeShellHandles.delete(10);
    activeShellHandles.delete(11);
  });
});

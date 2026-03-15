import { describe, test, expect, beforeEach } from "vitest";
import { activeHandles, sweepDeadHandles } from "../src/session-handles.js";
import type { ChildProcess } from "node:child_process";

function makeHandle(
  exitCode: number | null,
  killed: boolean,
  pid: number | undefined,
) {
  return {
    process: { exitCode, killed, pid } as unknown as ChildProcess,
    invocationId: 0,
    sessionId: null,
    result: null,
    done: new Promise(() => {}),
    kill: () => {},
  };
}

beforeEach(() => {
  activeHandles.clear();
});

describe("sweepDeadHandles", () => {
  test("removes handle whose process has a non-null exitCode", () => {
    activeHandles.set(1, makeHandle(0, false, 1234));
    const swept = sweepDeadHandles();
    expect(swept).toBe(1);
    expect(activeHandles.has(1)).toBe(false);
  });

  test("removes handle whose process has been killed", () => {
    activeHandles.set(2, makeHandle(null, true, 1234));
    const swept = sweepDeadHandles();
    expect(swept).toBe(1);
    expect(activeHandles.has(2)).toBe(false);
  });

  test("removes handle whose process has no pid (never started)", () => {
    activeHandles.set(3, makeHandle(null, false, undefined));
    const swept = sweepDeadHandles();
    expect(swept).toBe(1);
    expect(activeHandles.has(3)).toBe(false);
  });

  test("keeps a live handle (exitCode null, not killed, has pid)", () => {
    activeHandles.set(4, makeHandle(null, false, 5678));
    const swept = sweepDeadHandles();
    expect(swept).toBe(0);
    expect(activeHandles.has(4)).toBe(true);
  });

  test("returns correct count when multiple handles are dead", () => {
    activeHandles.set(10, makeHandle(1, false, 100)); // dead (exitCode)
    activeHandles.set(11, makeHandle(null, true, 101)); // dead (killed)
    activeHandles.set(12, makeHandle(null, false, 102)); // alive
    const swept = sweepDeadHandles();
    expect(swept).toBe(2);
    expect(activeHandles.has(10)).toBe(false);
    expect(activeHandles.has(11)).toBe(false);
    expect(activeHandles.has(12)).toBe(true);
  });

  test("returns 0 when map is empty", () => {
    const swept = sweepDeadHandles();
    expect(swept).toBe(0);
  });
});

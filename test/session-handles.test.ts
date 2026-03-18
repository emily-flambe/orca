import { describe, test, expect, beforeEach } from "vitest";
import { activeHandles, sweepExitedHandles } from "../src/session-handles.js";
import type { ChildProcess } from "node:child_process";

function makeHandle(procOverrides: Partial<ChildProcess> = {}) {
  return {
    done: new Promise(() => {}),
    sessionId: null,
    process: {
      exitCode: null,
      killed: false,
      pid: 1234,
      ...procOverrides,
    } as unknown as ChildProcess,
    kill: () => {},
  };
}

beforeEach(() => {
  activeHandles.clear();
});

describe("sweepExitedHandles", () => {
  test("returns 0 when map is empty", () => {
    expect(sweepExitedHandles()).toBe(0);
  });

  test("removes handle whose process has exitCode set", () => {
    activeHandles.set(1, makeHandle({ exitCode: 0 }));
    expect(sweepExitedHandles()).toBe(1);
    expect(activeHandles.size).toBe(0);
  });

  test("removes handle whose process is killed", () => {
    activeHandles.set(2, makeHandle({ killed: true }));
    expect(sweepExitedHandles()).toBe(1);
    expect(activeHandles.size).toBe(0);
  });

  test("removes handle whose process has no pid", () => {
    activeHandles.set(3, makeHandle({ pid: undefined }));
    expect(sweepExitedHandles()).toBe(1);
    expect(activeHandles.size).toBe(0);
  });

  test("keeps handle whose process is still running", () => {
    activeHandles.set(
      4,
      makeHandle({ exitCode: null, killed: false, pid: 42 }),
    );
    expect(sweepExitedHandles()).toBe(0);
    expect(activeHandles.size).toBe(1);
  });

  test("mixed: removes exited handles, keeps live ones", () => {
    activeHandles.set(5, makeHandle({ exitCode: 1 })); // exited
    activeHandles.set(
      6,
      makeHandle({ exitCode: null, killed: false, pid: 99 }),
    ); // live
    activeHandles.set(7, makeHandle({ killed: true })); // killed
    expect(sweepExitedHandles()).toBe(2);
    expect(activeHandles.has(5)).toBe(false);
    expect(activeHandles.has(6)).toBe(true);
    expect(activeHandles.has(7)).toBe(false);
  });
});

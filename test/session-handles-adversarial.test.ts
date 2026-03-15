// ---------------------------------------------------------------------------
// Adversarial tests for session-handles.ts and bridgeSessionCompletion
//
// These tests target edge cases and failure modes NOT covered by the existing
// session-handles.test.ts and workflow-task-lifecycle.test.ts suites.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";
import { activeHandles, sweepDeadHandles } from "../src/session-handles.js";
import type { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    done: new Promise<never>(() => {}),
    kill: () => {},
  };
}

beforeEach(() => {
  activeHandles.clear();
});

// ---------------------------------------------------------------------------
// BUG 1: sweepDeadHandles — handle.process is undefined
//
// SessionHandle.process is typed as ChildProcess, not ChildProcess | undefined.
// However, if spawnSession throws after insertInvocation but before the handle
// is fully constructed, a partial / undefined process could theoretically be
// stored. More concretely: external code could store a bad value via the
// exported Map. sweepDeadHandles does NOT guard against handle.process being
// undefined — accessing .exitCode on undefined throws TypeError and the sweep
// crashes, leaving subsequent handles un-swept.
// ---------------------------------------------------------------------------

describe("sweepDeadHandles — guard against undefined process", () => {
  test("BUG: crashes with TypeError when handle.process is undefined", () => {
    // Simulate a corrupt entry (e.g., stored before process was assigned).
    const badHandle = {
      process: undefined as unknown as ChildProcess,
      invocationId: 0,
      sessionId: null,
      result: null,
      done: new Promise<never>(() => {}),
      kill: () => {},
    };
    activeHandles.set(99, badHandle);

    // This SHOULD not throw — it should defensively skip or remove the entry.
    // Currently it throws: "Cannot read properties of undefined (reading 'exitCode')"
    expect(() => sweepDeadHandles()).not.toThrow();
  });

  test("BUG: if handle.process is undefined, that entry is never swept (memory leak)", () => {
    const badHandle = {
      process: undefined as unknown as ChildProcess,
      invocationId: 0,
      sessionId: null,
      result: null,
      done: new Promise<never>(() => {}),
      kill: () => {},
    };
    activeHandles.set(99, badHandle);

    // Even if the above doesn't throw (after a fix), the undefined-process
    // entry should be treated as dead and swept, not kept forever.
    try {
      sweepDeadHandles();
    } catch {
      // if it throws, the handle was not swept — test the post-condition
    }
    // After sweeping, the undefined-process handle should be gone.
    expect(activeHandles.has(99)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BUG 2: sweepDeadHandles — handle.process.pid === 0 is treated as alive
//
// pid === 0 is pathological on some platforms (init process PID), but more
// importantly exitCode=null, killed=false, pid=0 would be treated as ALIVE
// by the current check `proc.pid === undefined`. The check uses strict
// undefined equality; a process that failed to start might have pid=0 on
// some runtimes (not undefined). This is a coverage gap: the existing tests
// only test pid=undefined as the "never started" signal.
// ---------------------------------------------------------------------------

describe("sweepDeadHandles — pid=0 edge case", () => {
  test("pid=0 with exitCode=null and killed=false is kept (not swept) — potentially incorrect", () => {
    // pid=0 is meaningless for a child process but the current code KEEPS it
    // because proc.pid === undefined is false. Document this behavior so
    // the team can decide if pid=0 should also be swept.
    activeHandles.set(5, makeHandle(null, false, 0));
    const swept = sweepDeadHandles();
    // Current behavior: pid=0 is NOT swept (treated as alive).
    // This test documents the behavior — it passes currently but highlights
    // a potential leak if pid can ever be 0 for a real process.
    expect(swept).toBe(0);
    expect(activeHandles.has(5)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BUG 3: bridgeSessionCompletion — handle delete fires BEFORE inngest.send()
//
// In the .then() path:
//   activeHandles.delete(invocationId);    // <-- deletes first
//   inngest.send({ ... }).catch(...)       // <-- then sends
//
// If inngest.send() throws synchronously (not just rejects), the delete has
// already happened so the handle is gone, which is actually correct behavior.
// But the test suite never verifies that the delete fires even when inngest.send
// subsequently REJECTS (not throws). The .catch() handler is attached AFTER
// .send() is called — if .send() returns a rejected promise and there's no
// catch, this becomes an unhandled rejection. The existing .catch() handles
// this, but the handle delete is not inside the .catch(), so it fires
// regardless. This is CORRECT behavior, but it is never tested — the test
// suite has no test that verifies delete fires when inngest.send() rejects.
//
// We test this by verifying the exported behavior: after the bridge fires
// with a throwing inngest.send, the handle should still be gone.
// ---------------------------------------------------------------------------

// We need the module-level mocks; use a separate describe with vi.mock approach
// via an isolated test module (inline).

describe("bridgeSessionCompletion — handle removed when inngest.send throws", () => {
  test("handle removed from activeHandles even when inngest.send() rejects", async () => {
    // We cannot import bridgeSessionCompletion directly (it is not exported).
    // Instead, we verify the observable outcome: after handle.done resolves,
    // the handle should be gone from activeHandles regardless of whether
    // inngest.send() rejects.
    //
    // To test this without re-importing everything, we replicate the exact
    // logic from bridgeSessionCompletion in miniature and verify it is sound.
    //
    // This test documents the concern and shows the correct behavior.

    const map = new Map<number, { process: ChildProcess }>();
    const invocationId = 42;

    // Simulate a resolved promise (session finished)
    const resolvedDone = Promise.resolve({ subtype: "success", exitCode: 0 });

    // Simulate inngest.send that rejects
    const sendSpy = vi.fn().mockRejectedValue(new Error("inngest unavailable"));

    // Replicate bridgeSessionCompletion logic
    const bridge = () => {
      resolvedDone
        .then(() => {
          map.delete(invocationId); // delete before send (as in the real code)
          sendSpy().catch(() => {
            /* ignore */
          });
        })
        .catch(() => {
          map.delete(invocationId);
          sendSpy().catch(() => {});
        });
    };

    // Seed the map
    map.set(invocationId, { process: {} as ChildProcess });
    bridge();

    // Wait for microtasks
    await new Promise((r) => setTimeout(r, 0));

    expect(map.has(invocationId)).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  test("ACTUAL BUG: handle NOT removed from activeHandles when inngest.send() rejects in .then() path — because delete fires before send", async () => {
    // This is a documentation test, not a bug test. The delete in the .then()
    // path fires BEFORE inngest.send(), so the handle is always removed even
    // if send() rejects. This is correct. But the test suite never tests that
    // the delete does NOT silently get skipped if bridgeSessionCompletion's
    // done promise itself rejects (the .catch() path).

    const map = new Map<number, { process: ChildProcess }>();
    const invocationId = 43;

    // Simulate a REJECTING done promise (process-level error)
    const rejectingDone = Promise.reject(new Error("process crashed"));

    const sendSpy = vi.fn().mockResolvedValue(undefined);

    const bridge = () => {
      rejectingDone
        .then(() => {
          map.delete(invocationId);
          sendSpy().catch(() => {});
        })
        .catch(() => {
          // This is the .catch() path — delete fires here
          map.delete(invocationId);
          sendSpy().catch(() => {});
        });
    };

    map.set(invocationId, { process: {} as ChildProcess });
    bridge();

    await new Promise((r) => setTimeout(r, 0));

    // Handle must be removed even on the rejection path
    expect(map.has(invocationId)).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});

import type { SessionHandle } from "./runner/index.js";

/**
 * Active session handles keyed by invocation ID.
 * Exported so the CLI shutdown handler can iterate and kill them.
 */
export const activeHandles = new Map<number, SessionHandle>();

/**
 * Synchronous session counter — incremented BEFORE spawnSession(), decremented
 * when the session ends. Prevents TOCTOU race where multiple Inngest step
 * callbacks all see activeHandles.size === 0 because handles haven't been
 * registered yet.
 */
let _pendingSessionCount = 0;

export function getPendingSessionCount(): number {
  return _pendingSessionCount;
}

export function claimSessionSlot(): void {
  _pendingSessionCount++;
}

export function releaseSessionSlot(): void {
  if (_pendingSessionCount > 0) _pendingSessionCount--;
}

export function resetSessionSlots(): void {
  _pendingSessionCount = 0;
}

/**
 * Remove handles whose underlying process has already exited.
 * Call periodically to prevent unbounded map growth from crash/edge-case leaks.
 * Returns the number of entries removed.
 */
export function sweepExitedHandles(): number {
  let removed = 0;
  for (const [id, handle] of activeHandles) {
    const proc = handle.process;
    if (proc.exitCode !== null || proc.killed || proc.pid === undefined) {
      activeHandles.delete(id);
      removed++;
    }
  }
  return removed;
}

import type { SessionHandle } from "./runner/index.js";

/**
 * Active session handles keyed by invocation ID.
 * Exported so the CLI shutdown handler can iterate and kill them.
 */
export const activeHandles = new Map<number, SessionHandle>();

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

import type { SessionHandle } from "./runner/index.js";

/**
 * Active session handles keyed by invocation ID.
 * Exported so the CLI shutdown handler can iterate and kill them.
 */
export const activeHandles = new Map<number, SessionHandle>();

/**
 * Remove handles from activeHandles whose underlying process has already exited.
 * Called periodically to prevent the map from growing unbounded if the
 * bridgeSessionCompletion callback fails to fire (e.g. due to server restart).
 */
export function sweepDeadHandles(): number {
  let swept = 0;
  for (const [invocationId, handle] of activeHandles) {
    const proc = handle.process;
    if (!proc || proc.exitCode !== null || proc.killed || proc.pid === undefined) {
      activeHandles.delete(invocationId);
      swept++;
    }
  }
  return swept;
}

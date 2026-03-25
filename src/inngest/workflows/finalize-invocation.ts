/**
 * Single point of invocation finalization. Prevents the class of bugs
 * where task status is updated but the invocation record is left as
 * "running" with no endedAt.
 */
import { getInvocation, updateInvocation } from "../../db/queries.js";
import { activeHandles } from "../../session-handles.js";
import type { OrcaDb } from "../../db/index.js";

export interface SessionResultData {
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  numTurns?: number | null;
  outputSummary?: string | null;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "timed_out"]);

export function finalizeInvocation(
  db: OrcaDb,
  invocationId: number,
  status: "completed" | "failed" | "timed_out",
  data?: SessionResultData,
): void {
  try {
    // Guard: don't overwrite an already-finalized invocation.
    // This prevents the bridge DB fallback + workflow timeout race from
    // clobbering accurate data with a later, less-informed write.
    const existing = getInvocation(db, invocationId);
    if (existing && TERMINAL_STATUSES.has(existing.status)) return;

    const updates: Parameters<typeof updateInvocation>[2] = {
      status,
      endedAt: new Date().toISOString(),
    };
    if (data) {
      if (data.costUsd !== undefined) updates.costUsd = data.costUsd;
      if (data.inputTokens !== undefined)
        updates.inputTokens = data.inputTokens;
      if (data.outputTokens !== undefined)
        updates.outputTokens = data.outputTokens;
      if (data.numTurns !== undefined) updates.numTurns = data.numTurns;
      if (data.outputSummary !== undefined)
        updates.outputSummary = data.outputSummary;
    }
    updateInvocation(db, invocationId, updates);
  } finally {
    activeHandles.delete(invocationId);
  }
}

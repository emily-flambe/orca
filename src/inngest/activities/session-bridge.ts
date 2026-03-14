/**
 * Bridges the imperative runner (child process) with Inngest's event-driven workflows.
 *
 * After spawning a Claude session, call `monitorSession()` to fire-and-forget
 * a listener that emits an Inngest event when the session completes. The
 * Inngest workflow uses `step.waitForEvent()` to pick up the result.
 */

import { inngest } from "../client.js";
import type { SessionHandle, SessionResult } from "../../runner/index.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("session-bridge");

/**
 * Monitors a running Claude session and emits an Inngest event when it completes.
 *
 * This runs fire-and-forget — the promise is not returned to the caller.
 * The Inngest workflow picks up the result via `step.waitForEvent()`.
 */
export function monitorSession(
  handle: SessionHandle,
  taskId: string,
  phase: "implement" | "review",
  invocationId: number,
  meta?: {
    branchName?: string | null;
    worktreePath?: string | null;
  },
): void {
  handle.done
    .then(async (result: SessionResult) => {
      const isSuccess = result.subtype === "success";
      const isMaxTurns = result.subtype === "error_max_turns";
      const isRateLimited = result.subtype === "rate_limited";
      const isContentFiltered =
        result.subtype === "error_during_execution" &&
        !!result.outputSummary?.includes(
          "Output blocked by content filtering policy",
        );

      if (isSuccess || isMaxTurns) {
        await inngest.send({
          name: "session/completed",
          data: {
            invocationId,
            linearIssueId: taskId,
            phase,
            exitCode: result.exitCode ?? 0,
            summary: result.outputSummary,
            costUsd: result.costUsd,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            sessionId: handle.sessionId,
            branchName: meta?.branchName ?? null,
            worktreePath: meta?.worktreePath ?? null,
            numTurns: result.numTurns,
            isMaxTurns,
          },
        });
      } else {
        await inngest.send({
          name: "session/failed",
          data: {
            invocationId,
            linearIssueId: taskId,
            phase,
            exitCode: result.exitCode ?? 1,
            errorMessage: result.outputSummary,
            isRateLimited,
            isContentFiltered,
            isDllInit: false, // DLL init is detected at spawn time, not session result
            isMaxTurns,
            sessionId: handle.sessionId,
            worktreePath: meta?.worktreePath ?? null,
            costUsd: result.costUsd,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
          },
        });
      }
    })
    .catch((err) => {
      logger.error(
        `error emitting Inngest event for invocation ${invocationId}:`,
        err,
      );
    });
}

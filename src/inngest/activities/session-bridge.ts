/**
 * Bridges the imperative runner (child process) with Inngest's event-driven workflows.
 *
 * After spawning a Claude session, call `monitorSession()` to fire-and-forget
 * a listener that emits an Inngest event when the session completes. The
 * Inngest workflow uses `step.waitForEvent()` to pick up the result.
 */

import { inngest } from "../client.js";
import type { SessionHandle, SessionResult } from "../../runner/index.js";
import type { OrcaEvents } from "../events.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("session-bridge");

/**
 * Sends an Inngest event with exponential backoff retry.
 * Retries up to `maxAttempts` times (delays: 1s, 2s, 4s, ...).
 */
export async function sendWithRetry<K extends keyof OrcaEvents>(
  name: K,
  data: OrcaEvents[K] extends { data: infer D } ? D : never,
  maxAttempts = 3,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await inngest.send({ name, data } as Parameters<typeof inngest.send>[0]);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const delayMs = Math.pow(2, attempt - 1) * 1000;
        logger.warn(
          `[orca/session-bridge] inngest.send("${String(name)}") attempt ${attempt}/${maxAttempts} failed, retrying in ${delayMs}ms:`,
          err,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  logger.error(
    `[orca/session-bridge] inngest.send("${String(name)}") failed after ${maxAttempts} attempts:`,
    lastError,
  );
}

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
        await sendWithRetry("session/completed", {
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
        });
      } else {
        await sendWithRetry("session/failed", {
          invocationId,
          linearIssueId: taskId,
          phase,
          exitCode: result.exitCode ?? 1,
          errorMessage: result.outputSummary ?? "",
          isRateLimited,
          isContentFiltered,
          isDllInit: false, // DLL init is detected at spawn time, not session result
          isMaxTurns,
          sessionId: handle.sessionId,
          worktreePath: meta?.worktreePath ?? null,
          costUsd: result.costUsd,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });
      }
    })
    .catch((err) => {
      logger.error(
        `[orca/session-bridge] error emitting Inngest event for invocation ${invocationId}:`,
        err,
      );
    });
}

// ---------------------------------------------------------------------------
// Write-back retry queue
// Provides fire-and-forget retry logic for Linear API write-backs.
// ---------------------------------------------------------------------------

export const WRITE_BACK_RETRY_DELAYS_MS = [1000, 5000, 30000] as const;

let failedWriteBackCount = 0;

export function getFailedWriteBackCount(): number {
  return failedWriteBackCount;
}

export function resetFailedWriteBackCount(): void {
  failedWriteBackCount = 0;
}

/**
 * Runs `fn` immediately, retrying with delays on failure.
 * - Attempt 1: immediate
 * - Attempt 2: after WRITE_BACK_RETRY_DELAYS_MS[0] ms
 * - Attempt 3: after WRITE_BACK_RETRY_DELAYS_MS[1] ms
 * - Attempt 4: after WRITE_BACK_RETRY_DELAYS_MS[2] ms
 * - If attempt 4 fails: increments counter, logs at warn level
 *
 * Fire-and-forget — returns void immediately.
 */
export function scheduleWithRetry(
  fn: () => Promise<void>,
  label: string,
): void {
  void (async () => {
    // Attempt 0 (immediate)
    try {
      await fn();
      return;
    } catch (err) {
      // Fall through to retry loop
      let lastErr: unknown = err;
      for (let i = 0; i < WRITE_BACK_RETRY_DELAYS_MS.length; i++) {
        const delayMs = WRITE_BACK_RETRY_DELAYS_MS[i];
        console.warn(
          `[orca/sync] write-back failed for ${label}, retry ${i + 1}/${WRITE_BACK_RETRY_DELAYS_MS.length} in ${delayMs}ms: ${lastErr}`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        try {
          await fn();
          return;
        } catch (retryErr) {
          lastErr = retryErr;
        }
      }
      // All retries exhausted
      failedWriteBackCount++;
      console.warn(
        `[orca/sync] write-back permanently failed for ${label} after ${WRITE_BACK_RETRY_DELAYS_MS.length + 1} attempts: ${lastErr}`,
      );
    }
  })();
}

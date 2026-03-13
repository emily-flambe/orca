// ---------------------------------------------------------------------------
// Async utilities — retry wrapper and failure tracking
// ---------------------------------------------------------------------------

/**
 * Retry wrapper for async operations.
 * Tries `fn()` up to `options.attempts` times, waiting `options.delayMs`
 * between each attempt. Calls `options.onFailure` after each failed attempt.
 * Throws on final failure.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    attempts: number;
    delayMs: number;
    label: string;
    onFailure?: (attempt: number, err: unknown) => void;
  },
): Promise<T> {
  if (options.attempts < 1) {
    throw new Error(
      `withRetry: attempts must be >= 1, got ${options.attempts} for "${options.label}"`,
    );
  }
  let lastErr: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      options.onFailure?.(attempt, err);
      if (attempt < options.attempts) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
    }
  }
  throw lastErr;
}

/**
 * Tracks consecutive failures per task ID and escalates log level once
 * the count reaches the configured threshold.
 */
export class TaskFailureTracker {
  private readonly counts = new Map<string, number>();
  private readonly threshold: number;
  private readonly prefix: string;

  constructor(threshold: number = 3, prefix: string = "[orca/scheduler]") {
    this.threshold = threshold;
    this.prefix = prefix;
  }

  /** Record a failure. Returns the new count. */
  record(taskId: string): number {
    const next = (this.counts.get(taskId) ?? 0) + 1;
    this.counts.set(taskId, next);
    return next;
  }

  /** Reset count after success. */
  clear(taskId: string): void {
    this.counts.delete(taskId);
  }

  /** Get current count for a task. */
  getCount(taskId: string): number {
    return this.counts.get(taskId) ?? 0;
  }

  /** Get all entries with count > 0 (for API exposure). */
  getAll(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [id, count] of this.counts) {
      if (count > 0) result[id] = count;
    }
    return result;
  }

  /**
   * Log at warn level if count >= threshold, else at log level.
   * Callers pass the full message including the module prefix.
   */
  logFailure(taskId: string, message: string): void {
    const count = this.getCount(taskId);
    if (count >= this.threshold) {
      console.warn(`${this.prefix} ${message}`);
    } else {
      console.log(`${this.prefix} ${message}`);
    }
  }
}

/**
 * Retry an async operation with a constant delay between attempts.
 *
 * @param fn - The async function to retry
 * @param maxAttempts - Maximum number of attempts (default 3)
 * @param delayMs - Delay in milliseconds between attempts (default 1000)
 * @returns The resolved value, or throws if all attempts fail
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  delayMs = 1000,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

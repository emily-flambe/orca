/**
 * Format a token count into a human-readable string.
 * < 1M: "1.2K"
 * >= 1M: "1.2M"
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

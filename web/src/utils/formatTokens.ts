/**
 * Format a token count for display.
 * Examples: 0 → "0", 1234 → "1.2K", 45000 → "45K", 1234567 → "1.2M"
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

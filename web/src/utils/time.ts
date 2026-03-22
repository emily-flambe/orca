export function timeAgo(date: Date | string): string {
  const ms =
    Date.now() -
    (date instanceof Date ? date.getTime() : new Date(date).getTime());
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Format an ISO timestamp as a short locale string.
 * e.g. "Mar 22, 10:30:15 AM"
 */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Format an ISO timestamp as a short locale string (no seconds).
 * e.g. "Mar 22, 10:30 AM"
 */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Format a duration in milliseconds as a human-readable string.
 * Accepts `null` (returns dash) or a number of milliseconds.
 */
export function formatDurationMs(ms: number | null): string {
  if (ms == null) return "\u2014";
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

/**
 * Format a duration from start/end ISO timestamps.
 * If endedAt is null, returns the provided `runningLabel` (default: "running").
 */
export function formatDurationRange(
  startedAt: string,
  endedAt: string | null,
  runningLabel = "running",
): string {
  if (!endedAt) return runningLabel;
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

export function formatUptime(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return `${d}d ${h}h`;
}

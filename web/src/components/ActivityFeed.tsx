import type { ActivityEntry } from "../hooks/useApi";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function statusColor(s: string): string {
  switch (s) {
    case "completed":
      return "text-green-400";
    case "running":
      return "text-blue-400";
    case "failed":
      return "text-red-400";
    case "timed_out":
      return "text-orange-400";
    default:
      return "text-gray-400";
  }
}

function statusDot(s: string): string {
  switch (s) {
    case "completed":
      return "bg-green-400";
    case "running":
      return "bg-blue-400";
    case "failed":
      return "bg-red-400";
    case "timed_out":
      return "bg-orange-400";
    default:
      return "bg-gray-500";
  }
}

interface Props {
  entries: ActivityEntry[];
  onNavigate?: (linearIssueId: string, invocationId: number) => void;
}

export default function ActivityFeed({ entries, onNavigate }: Props) {
  if (entries.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-gray-500">
        No recent activity
      </div>
    );
  }

  return (
    <div className="divide-y divide-gray-800">
      {entries.map((entry) => (
        <div
          key={entry.id}
          onClick={() => onNavigate?.(entry.linearIssueId, entry.id)}
          className={`flex items-center gap-3 py-2.5 px-1 rounded transition-colors${onNavigate ? " cursor-pointer hover:bg-gray-800/60" : ""}`}
        >
          <span
            className={`inline-block h-2 w-2 rounded-full shrink-0 ${statusDot(entry.status)}`}
          />
          <span className="font-mono text-sm text-gray-200 shrink-0">
            {entry.linearIssueId}
          </span>
          {entry.phase && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">
              {entry.phase}
            </span>
          )}
          <span className={`text-xs ${statusColor(entry.status)}`}>
            {entry.status}
          </span>
          <span className="flex-1" />
          {(entry.inputTokens != null || entry.outputTokens != null) && (
            <span className="text-xs text-gray-500 font-mono tabular-nums">
              {formatTokens(
                (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0),
              )}
            </span>
          )}
          <span className="text-xs text-gray-600 tabular-nums whitespace-nowrap">
            {timeAgo(entry.startedAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

import type { ActivityItem } from "../hooks/useApi";

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

function statusDot(status: string): string {
  switch (status) {
    case "completed": return "bg-green-500";
    case "running": return "bg-blue-500 animate-pulse";
    case "failed":
    case "timed_out": return "bg-red-500";
    default: return "bg-gray-500";
  }
}

function statusText(status: string): string {
  switch (status) {
    case "completed": return "text-green-400";
    case "running": return "text-blue-400";
    case "failed":
    case "timed_out": return "text-red-400";
    default: return "text-gray-400";
  }
}

interface Props {
  items: ActivityItem[];
}

export default function ActivityFeed({ items }: Props) {
  if (items.length === 0) {
    return <div className="text-sm text-gray-500 py-4 text-center">No activity yet</div>;
  }

  return (
    <div className="divide-y divide-gray-800">
      {items.map((item) => (
        <div key={item.id} className="flex items-start gap-3 py-2.5 px-1">
          <span className={`mt-1.5 inline-block h-2 w-2 rounded-full shrink-0 ${statusDot(item.status)}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-sm text-gray-200">{item.linearIssueId}</span>
              {item.phase && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">{item.phase}</span>
              )}
              <span className={`text-xs ${statusText(item.status)}`}>{item.status}</span>
              {item.costUsd != null && (
                <span className="text-xs text-gray-500 font-mono">${item.costUsd.toFixed(2)}</span>
              )}
            </div>
            {item.outputSummary && (
              <div className="text-xs text-gray-500 truncate mt-0.5">{item.outputSummary}</div>
            )}
          </div>
          <span className="text-xs text-gray-600 whitespace-nowrap shrink-0">
            {timeAgo(item.startedAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

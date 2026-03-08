import { useState } from "react";
import type { Invocation } from "../types";
import StatusBadge from "./ui/StatusBadge";
import LogViewer from "./LogViewer";
import LiveRunWidget from "./LiveRunWidget";

interface Props {
  invocations: Invocation[];
  taskId: string;
  onAborted: () => void;
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "running...";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function getDotColor(status: string): string {
  switch (status) {
    case "completed":
      return "bg-green-500";
    case "running":
      return "bg-blue-500";
    case "failed":
      return "bg-red-500";
    case "timed_out":
      return "bg-orange-500";
    default:
      return "bg-gray-500";
  }
}

export default function InvocationTimeline({ invocations, onAborted }: Props) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const sorted = [...invocations].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  if (sorted.length === 0) {
    return <p className="text-sm text-gray-500 italic">No invocations yet</p>;
  }

  return (
    <div className="relative">
      {sorted.map((inv, idx) => {
        const isExpanded = expandedId === inv.id;
        const isRunning = inv.status === "running";
        const isLast = idx === sorted.length - 1;

        return (
          <div key={inv.id} className="relative flex gap-4">
            {/* Left column: dot + vertical line */}
            <div className="flex flex-col items-center">
              <div className={`mt-1.5 h-3 w-3 rounded-full shrink-0 ${getDotColor(inv.status)}`} />
              {!isLast && <div className="w-px flex-1 bg-gray-700 mt-1" />}
            </div>

            {/* Right column: content */}
            <div className={`flex-1 pb-6 ${isLast ? "pb-0" : ""}`}>
              {/* Summary row — clickable */}
              <button
                onClick={() => setExpandedId(isExpanded ? null : inv.id)}
                className="w-full text-left"
              >
                <div className="flex flex-wrap items-center gap-2">
                  {inv.phase && (
                    <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-blue-500/20 text-blue-300">
                      {inv.phase}
                    </span>
                  )}
                  <StatusBadge status={inv.status} />
                  <span className="text-xs text-gray-400 tabular-nums">
                    {formatDuration(inv.startedAt, inv.endedAt)}
                  </span>
                  {inv.costUsd != null && (
                    <span className="text-xs text-gray-400 tabular-nums font-mono">
                      ${inv.costUsd.toFixed(2)}
                    </span>
                  )}
                  <span className="text-xs text-gray-500 ml-auto">
                    {isExpanded ? "▲" : "▼"}
                  </span>
                </div>
                <div className="text-xs text-gray-500 mt-0.5">{formatDate(inv.startedAt)}</div>
              </button>

              {/* Expanded content */}
              {isExpanded && (
                <div className="mt-3">
                  {isRunning ? (
                    <LiveRunWidget invocation={inv} onCancelled={onAborted} />
                  ) : (
                    <LogViewer
                      invocationId={inv.id}
                      isRunning={false}
                      outputSummary={inv.outputSummary}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

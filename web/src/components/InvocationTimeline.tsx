import { useState } from "react";
import type { Invocation } from "../types";
import StatusBadge from "./ui/StatusBadge";
import LogViewer from "./LogViewer";
import LiveRunWidget from "./LiveRunWidget";
import EmptyState from "./ui/EmptyState";

interface Props {
  invocations: Invocation[];
  taskId: string;
  onInvocationAborted: () => void;
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "running…";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

function dotClasses(status: Invocation["status"]): string {
  switch (status) {
    case "completed":
      return "bg-green-500";
    case "running":
      return "bg-blue-500";
    case "failed":
    case "timed_out":
      return "bg-red-500";
    default:
      return "bg-gray-500";
  }
}

interface EntryProps {
  invocation: Invocation;
  isLast: boolean;
  defaultExpanded: boolean;
  onAborted: () => void;
}

function TimelineEntry({ invocation: inv, isLast, defaultExpanded, onAborted }: EntryProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const isRunning = inv.status === "running";

  return (
    <div className="flex gap-3">
      {/* Left: connector line + dot */}
      <div className="flex flex-col items-center shrink-0">
        <div className="relative flex items-center justify-center w-4 h-4 mt-0.5 shrink-0">
          {isRunning ? (
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className={`relative inline-flex rounded-full h-3 w-3 ${dotClasses(inv.status)}`} />
            </span>
          ) : (
            <span className={`inline-flex rounded-full h-3 w-3 ${dotClasses(inv.status)}`} />
          )}
        </div>
        {!isLast && <div className="w-px flex-1 bg-gray-800 mt-1" />}
      </div>

      {/* Right: content */}
      <div className="flex-1 pb-4 min-w-0">
        {/* Header row — always visible, clickable */}
        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full text-left"
        >
          <div className="flex flex-wrap items-center gap-2 mb-1">
            {inv.phase && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 font-medium">
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
            <span className="flex-1" />
            <span className="text-gray-600 text-xs">{expanded ? "▲" : "▼"}</span>
          </div>

          {/* Summary subtitle — only when collapsed */}
          {!expanded && inv.outputSummary && (
            <p className="text-xs text-gray-500 line-clamp-2 mt-0.5 text-left">{inv.outputSummary}</p>
          )}
        </button>

        {/* Expanded content */}
        {expanded && (
          <div className="mt-2">
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
}

export default function InvocationTimeline({ invocations, taskId: _taskId, onInvocationAborted }: Props) {
  if (invocations.length === 0) {
    return <EmptyState message="No invocations yet" />;
  }

  const sorted = [...invocations].sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  );

  return (
    <div className="space-y-0">
      {sorted.map((inv, idx) => (
        <TimelineEntry
          key={inv.id}
          invocation={inv}
          isLast={idx === sorted.length - 1}
          defaultExpanded={idx === sorted.length - 1}
          onAborted={onInvocationAborted}
        />
      ))}
    </div>
  );
}

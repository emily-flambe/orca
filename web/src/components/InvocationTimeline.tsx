import { useState } from "react";
import type { Invocation } from "../types";
import { getStatusBadgeClasses } from "./ui/StatusBadge";
import LogViewer from "./LogViewer";
import LiveRunWidget from "./LiveRunWidget";
import { abortInvocation } from "../hooks/useApi";

interface Props {
  invocations: Invocation[];
  onRefresh: () => void;
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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatusDot({ status }: { status: Invocation["status"] }) {
  if (status === "running") {
    return (
      <span className="relative flex h-3 w-3 shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500" />
      </span>
    );
  }
  const colors: Record<string, string> = {
    completed: "bg-green-500",
    failed: "bg-red-500",
    timed_out: "bg-orange-500",
  };
  return (
    <span className={`inline-flex rounded-full h-3 w-3 shrink-0 ${colors[status] ?? "bg-gray-500"}`} />
  );
}

function StatusIcon({ status }: { status: Invocation["status"] }) {
  switch (status) {
    case "completed": return <span title="completed" className="text-green-400">✓</span>;
    case "failed": return <span title="failed" className="text-red-400">✗</span>;
    case "timed_out": return <span title="timed out" className="text-orange-400">⏱</span>;
    case "running": return <span title="running" className="text-blue-400">▶</span>;
    default: return null;
  }
}

interface EntryProps {
  invocation: Invocation;
  isLast: boolean;
  onRefresh: () => void;
}

function TimelineEntry({ invocation: inv, isLast, onRefresh }: EntryProps) {
  const [expanded, setExpanded] = useState(inv.status === "running");
  const isRunning = inv.status === "running";

  return (
    <div className="flex gap-3">
      {/* Timeline spine */}
      <div className="flex flex-col items-center shrink-0">
        <StatusDot status={inv.status} />
        {!isLast && <div className="w-px flex-1 bg-gray-800 mt-1" style={{ minHeight: "24px" }} />}
      </div>

      {/* Entry content */}
      <div className="flex-1 pb-4 min-w-0">
        {/* Header row */}
        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full text-left flex items-center gap-2 flex-wrap hover:bg-gray-800/40 rounded px-1 -mx-1 py-0.5 transition-colors"
        >
          {/* Phase badge */}
          {inv.phase ? (
            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 font-medium shrink-0">
              {inv.phase}
            </span>
          ) : (
            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-500/20 text-gray-400 font-medium shrink-0">
              implement
            </span>
          )}

          {/* Date */}
          <span className="text-xs text-gray-500 shrink-0">{formatDate(inv.startedAt)}</span>

          <span className="flex-1" />

          {/* Duration */}
          <span className="text-xs text-gray-400 tabular-nums shrink-0">
            {formatDuration(inv.startedAt, inv.endedAt)}
          </span>

          {/* Cost */}
          {inv.costUsd != null && (
            <span className="text-xs text-gray-400 tabular-nums font-mono shrink-0">
              ${inv.costUsd.toFixed(2)}
            </span>
          )}

          {/* Status */}
          <span className={`text-xs px-1.5 py-0.5 rounded-full shrink-0 ${getStatusBadgeClasses(inv.status)}`}>
            <StatusIcon status={inv.status} /> {inv.status === "timed_out" ? "timed out" : inv.status}
          </span>

          {/* Expand indicator */}
          <span className="text-xs text-gray-600 shrink-0">{expanded ? "▴" : "▾"}</span>
        </button>

        {/* Abort button for running */}
        {isRunning && (
          <div className="mt-1 ml-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (!window.confirm("Abort this invocation? The task will be reset to ready.")) return;
                abortInvocation(inv.id)
                  .then(onRefresh)
                  .catch(console.error);
              }}
              className="text-xs px-2 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
            >
              Abort
            </button>
          </div>
        )}

        {/* Expanded content */}
        {expanded && (
          <div className="mt-2">
            {isRunning ? (
              <LiveRunWidget invocation={inv} onCancelled={onRefresh} />
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

export default function InvocationTimeline({ invocations, onRefresh }: Props) {
  // Sort chronologically ascending (oldest first) for timeline readability,
  // but show the newest (running) at top by sorting descending.
  const sorted = [...invocations].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  if (sorted.length === 0) {
    return (
      <div className="text-sm text-gray-500 italic py-2">No invocations yet.</div>
    );
  }

  return (
    <div className="flex flex-col">
      {sorted.map((inv, idx) => (
        <TimelineEntry
          key={inv.id}
          invocation={inv}
          isLast={idx === sorted.length - 1}
          onRefresh={onRefresh}
        />
      ))}
    </div>
  );
}

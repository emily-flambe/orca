import { useState } from "react";
import type { Invocation, TaskWithInvocations } from "../types";
import LogViewer from "./LogViewer";
import LiveRunWidget from "./LiveRunWidget";
import { getStatusBadgeClasses } from "./ui/StatusBadge";

interface Props {
  invocations: Invocation[];
  task?: TaskWithInvocations;
  taskId: string;
  onAbort: (invId: number) => void;
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

function DotForStatus({ status }: { status: Invocation["status"] }) {
  if (status === "running") {
    return (
      <span className="relative flex h-3 w-3 shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-3 w-3 bg-cyan-500" />
      </span>
    );
  }
  const colorClass =
    status === "completed"
      ? "bg-green-500"
      : status === "failed"
      ? "bg-red-500"
      : status === "timed_out"
      ? "bg-orange-500"
      : "bg-gray-500";
  return <span className={`inline-flex rounded-full h-3 w-3 shrink-0 ${colorClass}`} />;
}

function StatusIcon({ status }: { status: Invocation["status"] }) {
  switch (status) {
    case "running":
      return <span className="text-cyan-400">⟳</span>;
    case "completed":
      return <span className="text-green-400">✓</span>;
    case "failed":
      return <span className="text-red-400">✗</span>;
    case "timed_out":
      return <span className="text-orange-400">⏱</span>;
  }
}

interface TimelineEntryProps {
  invocation: Invocation;
  isLast: boolean;
  defaultExpanded: boolean;
  onAbort: (invId: number) => void;
}

function TimelineEntry({ invocation: inv, isLast, defaultExpanded, onAbort }: TimelineEntryProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const duration = formatDuration(inv.startedAt, inv.endedAt);
  const isRunning = inv.status === "running";

  return (
    <div className="flex gap-3">
      {/* Left: dot + connector */}
      <div className="flex flex-col items-center">
        <div className="mt-3 z-10">
          <DotForStatus status={inv.status} />
        </div>
        {!isLast && <div className="flex-1 w-px bg-gray-700 mt-1" />}
      </div>

      {/* Right: card */}
      <div className="flex-1 pb-4 min-w-0">
        {/* Card header — always visible, clickable */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full text-left rounded-lg border border-gray-800 bg-gray-800/40 hover:bg-gray-800/60 transition-colors px-3 py-2.5"
        >
          <div className="flex items-center gap-2 flex-wrap">
            {/* Phase */}
            {inv.phase && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 font-medium">
                {inv.phase}
              </span>
            )}

            {/* Status badge */}
            <span className={`text-xs px-2 py-0.5 rounded-full flex items-center gap-1 ${getStatusBadgeClasses(inv.status)}`}>
              <StatusIcon status={inv.status} />
              <span>{inv.status === "completed" ? "completed" : inv.status}</span>
            </span>

            {/* Duration */}
            <span className="text-xs text-gray-400 tabular-nums">{duration}</span>

            {/* Cost */}
            {inv.costUsd != null && (
              <span className="text-xs text-gray-400 tabular-nums font-mono">${inv.costUsd.toFixed(2)}</span>
            )}

            {/* Turns */}
            {inv.numTurns != null && (
              <span className="text-xs text-gray-500">{inv.numTurns} turns</span>
            )}

            <span className="flex-1" />

            {/* Date */}
            <span className="text-xs text-gray-600">{formatDate(inv.startedAt)}</span>

            {/* Expand chevron */}
            <span className="text-gray-600 text-xs">{expanded ? "▴" : "▾"}</span>
          </div>

          {/* Output summary preview */}
          {!expanded && inv.outputSummary && (
            <p className="text-xs text-gray-500 mt-1.5 line-clamp-2">{inv.outputSummary}</p>
          )}
        </button>

        {/* Abort button (outside card header to avoid nesting buttons) */}
        {isRunning && (
          <div className="mt-1 px-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (!window.confirm("Abort this invocation? The task will be reset to ready.")) return;
                onAbort(inv.id);
              }}
              className="text-xs px-2 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
            >
              Abort
            </button>
          </div>
        )}

        {/* Expanded body */}
        {expanded && (
          <div className="mt-2 rounded-lg border border-gray-800 overflow-hidden">
            {isRunning ? (
              <LiveRunWidget invocation={inv} onCancelled={() => onAbort(inv.id)} />
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

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

interface ActivityEvent {
  timestamp: string;
  label: string;
  colorClass: string;
}

function deriveActivityEvents(
  invocations: Invocation[],
  task?: TaskWithInvocations,
): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  // Task created / synced event
  if (task) {
    events.push({
      timestamp: task.createdAt,
      label: "Task synced",
      colorClass: "bg-gray-500",
    });
  }

  for (const inv of invocations) {
    // Dispatch event
    events.push({
      timestamp: inv.startedAt,
      label: `Dispatched${inv.phase ? ` (${inv.phase})` : ""}`,
      colorClass: "bg-cyan-500",
    });

    if (inv.phase === "review") {
      // Review start event — use the invocation start time
      events.push({
        timestamp: inv.startedAt,
        label: "Review started",
        colorClass: "bg-purple-500",
      });
    }

    if (inv.endedAt) {
      if (inv.phase === "review") {
        events.push({
          timestamp: inv.endedAt,
          label: `Review ${inv.status === "completed" ? "completed" : inv.status}`,
          colorClass: inv.status === "completed" ? "bg-green-500" : "bg-red-500",
        });
      } else if (inv.status === "completed") {
        events.push({
          timestamp: inv.endedAt,
          label: `Invocation completed${inv.phase ? ` (${inv.phase})` : ""}`,
          colorClass: "bg-green-500",
        });
      } else if (inv.status === "failed") {
        events.push({
          timestamp: inv.endedAt,
          label: `Invocation failed${inv.phase ? ` (${inv.phase})` : ""}`,
          colorClass: "bg-red-500",
        });
      } else if (inv.status === "timed_out") {
        events.push({
          timestamp: inv.endedAt,
          label: `Invocation timed out${inv.phase ? ` (${inv.phase})` : ""}`,
          colorClass: "bg-orange-500",
        });
      }
    }
  }

  // PR created event — use the earliest invocation end time as a proxy timestamp
  // (the PR is created at the end of the first successful implement phase)
  if (task?.prNumber != null) {
    const firstCompletedImpl = invocations
      .filter((inv) => inv.phase !== "review" && inv.status === "completed" && inv.endedAt)
      .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())[0];
    const prTimestamp = firstCompletedImpl?.endedAt ?? task.createdAt;
    events.push({
      timestamp: prTimestamp,
      label: `PR #${task.prNumber} created`,
      colorClass: "bg-yellow-500",
    });
  }

  return events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  if (diffSecs < 60) return `${diffSecs}s ago`;
  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function ActivityFeed({ invocations, task }: { invocations: Invocation[]; task?: TaskWithInvocations }) {
  const events = deriveActivityEvents(invocations, task);

  if (events.length === 0) return null;

  return (
    <div>
      <h3 className="text-sm text-gray-400 mb-3">Activity</h3>
      <div className="space-y-2">
        {events.map((event, idx) => (
          <div key={idx} className="flex items-center gap-2.5 text-xs text-gray-400">
            <span className={`inline-flex rounded-full h-2 w-2 shrink-0 ${event.colorClass}`} />
            <span className="flex-1">{event.label}</span>
            <span className="text-gray-600 tabular-nums shrink-0">{formatRelativeTime(event.timestamp)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export default function InvocationTimeline({ invocations, task, taskId: _taskId, onAbort }: Props) {
  // Sort oldest first
  const sorted = [...invocations].sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  );

  if (sorted.length === 0) {
    return (
      <div className="space-y-6">
        <div className="text-sm text-gray-500 italic">No invocations yet.</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Timeline */}
      <div>
        <h3 className="text-sm text-gray-400 mb-3">Invocation History</h3>
        <div>
          {sorted.map((inv, idx) => (
            <TimelineEntry
              key={inv.id}
              invocation={inv}
              isLast={idx === sorted.length - 1}
              defaultExpanded={inv.status === "running"}
              onAbort={onAbort}
            />
          ))}
        </div>
      </div>

      {/* Activity feed */}
      <ActivityFeed invocations={sorted} task={task} />
    </div>
  );
}

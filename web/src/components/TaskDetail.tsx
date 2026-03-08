import { useState, useEffect, useCallback } from "react";
import type { TaskWithInvocations, Invocation } from "../types";
import { fetchTaskDetail, retryTask } from "../hooks/useApi";
import { getStatusBadgeClasses } from "./ui/StatusBadge";
import Skeleton from "./ui/Skeleton";
import PropertiesPanel from "./PropertiesPanel";
import InvocationTimeline from "./InvocationTimeline";

// ---------------------------------------------------------------------------
// Session-level panel state — persists across task navigation (no reload).
// ---------------------------------------------------------------------------
let _panelOpen = false;

interface Props {
  taskId: string;
}

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

interface ActivityEvent {
  time: string;
  label: string;
  icon: string;
  colorClass: string;
}

function deriveActivityEvents(task: TaskWithInvocations): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  // Task synced from Linear
  events.push({
    time: task.createdAt,
    label: "Task synced from Linear",
    icon: "🔗",
    colorClass: "text-gray-400",
  });

  // Invocation events
  for (const inv of task.invocations ?? []) {
    const phase = inv.phase ?? "implement";

    events.push({
      time: inv.startedAt,
      label: `${phase.charAt(0).toUpperCase() + phase.slice(1)} dispatched`,
      icon: phase === "review" ? "👁" : phase === "fix" ? "🔧" : "🚀",
      colorClass: "text-blue-400",
    });

    if (inv.endedAt) {
      const resultLabel =
        inv.status === "completed"
          ? `${phase.charAt(0).toUpperCase() + phase.slice(1)} completed`
          : inv.status === "timed_out"
          ? `${phase} timed out`
          : `${phase} failed`;
      const icon =
        inv.status === "completed" ? "✓" : inv.status === "timed_out" ? "⏱" : "✗";
      const color =
        inv.status === "completed"
          ? "text-green-400"
          : inv.status === "timed_out"
          ? "text-orange-400"
          : "text-red-400";

      events.push({
        time: inv.endedAt,
        label: resultLabel,
        icon,
        colorClass: color,
      });
    }
  }

  // PR created — approximated from updatedAt when prNumber first appeared.
  // We surface it only if we have a PR number; the timestamp is best-effort.
  if (task.prNumber != null) {
    // Find the completed implement invocation nearest to the PR creation time.
    // Use task.updatedAt as the best available approximation.
    events.push({
      time: task.updatedAt,
      label: `PR #${task.prNumber} opened`,
      icon: "⬆",
      colorClass: "text-cyan-400",
    });
  }

  // Done
  if (task.doneAt) {
    events.push({
      time: task.doneAt,
      label: "Task marked done",
      icon: "🎉",
      colorClass: "text-green-400",
    });
  }

  // Sort chronologically
  return events.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
}

function formatActivityTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ActivityFeed({ task }: { task: TaskWithInvocations }) {
  const events = deriveActivityEvents(task);

  if (events.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {events.map((evt, idx) => (
        <div key={idx} className="flex items-start gap-2 text-xs">
          <span className="shrink-0 w-4 text-center">{evt.icon}</span>
          <span className={`shrink-0 ${evt.colorClass}`}>{evt.label}</span>
          <span className="text-gray-600 ml-auto shrink-0 tabular-nums">
            {formatActivityTime(evt.time)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function TaskDetail({ taskId }: Props) {
  const [detail, setDetail] = useState<TaskWithInvocations | null>(null);
  const [panelOpen, setPanelOpen] = useState(_panelOpen);

  // Sync module-level state whenever panel toggles
  const togglePanel = useCallback(() => {
    setPanelOpen((prev) => {
      _panelOpen = !prev;
      return !prev;
    });
  }, []);

  useEffect(() => {
    fetchTaskDetail(taskId)
      .then(setDetail)
      .catch(console.error);
  }, [taskId]);

  // Cmd+\ keyboard shortcut to toggle panel
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        togglePanel();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [togglePanel]);

  const handleRefresh = useCallback(() => {
    fetchTaskDetail(taskId)
      .then(setDetail)
      .catch(console.error);
  }, [taskId]);

  if (!detail) {
    return <Skeleton lines={3} className="m-4" />;
  }

  const invocations: Invocation[] = detail.invocations ?? [];

  return (
    <div className="flex h-full overflow-hidden">
      {/* Main content */}
      <div className="flex-1 overflow-y-auto min-w-0">
        <div className="p-4 space-y-6">
          {/* Header */}
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-mono font-semibold">{detail.linearIssueId}</h2>
            <span className={`text-xs px-2 py-0.5 rounded-full ${getStatusBadgeClasses(detail.orcaStatus)}`}>
              {detail.orcaStatus === "ready" ? "queued" : detail.orcaStatus}
            </span>

            {detail.orcaStatus === "failed" && (
              <button
                onClick={() => {
                  if (!window.confirm("Retry this task? It will be re-queued with fresh retry counters.")) return;
                  retryTask(detail.linearIssueId)
                    .then(handleRefresh)
                    .catch(console.error);
                }}
                className="text-xs px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 transition-colors"
              >
                Retry
              </button>
            )}

            <span className="flex-1" />

            {/* Properties panel toggle */}
            <button
              onClick={togglePanel}
              title="Toggle properties panel (⌘\)"
              className={`text-xs px-2 py-1 rounded border transition-colors ${
                panelOpen
                  ? "bg-gray-700 border-gray-600 text-gray-200"
                  : "bg-transparent border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-500"
              }`}
            >
              ⌘\
            </button>
          </div>

          {/* Agent prompt */}
          <div className="space-y-2">
            <label className="text-sm text-gray-400">Agent Prompt</label>
            <pre className="w-full bg-gray-900 border border-gray-700 rounded-lg p-3 text-sm text-gray-100 whitespace-pre-wrap">
              {detail.agentPrompt || (
                <span className="text-gray-500 italic">No prompt (issue has no description)</span>
              )}
            </pre>
          </div>

          {/* Invocation timeline */}
          <div className="space-y-2">
            <h3 className="text-sm text-gray-400">Invocation History</h3>
            <InvocationTimeline invocations={invocations} onRefresh={handleRefresh} />
          </div>

          {/* Activity feed */}
          {invocations.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm text-gray-400">Activity</h3>
              <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-3">
                <ActivityFeed task={detail} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Properties panel */}
      {panelOpen && (
        <div
          className="shrink-0 overflow-y-auto border-l border-gray-800"
          style={{ width: "320px" }}
        >
          <PropertiesPanel task={detail} onTaskUpdated={setDetail} />
        </div>
      )}
    </div>
  );
}

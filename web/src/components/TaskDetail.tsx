import { useState, useEffect } from "react";
import type { TaskWithInvocations, Invocation } from "../types";
import { fetchTaskDetail, retryTask } from "../hooks/useApi";
import { getStatusBadgeClasses } from "./ui/StatusBadge";
import Skeleton from "./ui/Skeleton";
import PropertiesPanel from "./PropertiesPanel";
import InvocationTimeline from "./InvocationTimeline";

interface Props {
  taskId: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

// ---------------------------------------------------------------------------
// Activity feed helpers
// ---------------------------------------------------------------------------

interface ActivityEvent {
  time: string;
  icon: string;
  label: string;
}

function buildActivityFeed(task: TaskWithInvocations): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  for (const inv of task.invocations || []) {
    if (inv.phase === "implement") {
      events.push({ time: inv.startedAt, icon: "→", label: "Implementation run dispatched" });
    } else if (inv.phase === "review") {
      events.push({ time: inv.startedAt, icon: "⟳", label: "Review started" });
      if (inv.status === "completed") {
        events.push({ time: inv.endedAt ?? inv.startedAt, icon: "✓", label: "Review completed" });
      }
    } else if (inv.phase === "fix") {
      events.push({ time: inv.startedAt, icon: "→", label: "Fix run dispatched" });
    }
  }

  if (task.prNumber != null) {
    // Approximate PR creation time: earliest review invocation, or task updatedAt
    const reviewInv = (task.invocations || []).find((i) => i.phase === "review");
    const prTime = reviewInv?.startedAt ?? task.updatedAt;
    events.push({ time: prTime, icon: "⎇", label: `PR #${task.prNumber} created` });
  }

  if (task.doneAt) {
    events.push({ time: task.doneAt, icon: "✓", label: "Task marked done" });
  }

  events.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  return events;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TaskDetail({ taskId }: Props) {
  const [detail, setDetail] = useState<TaskWithInvocations | null>(null);

  const [panelOpen, setPanelOpen] = useState<boolean>(() => {
    return sessionStorage.getItem("propertiesPanelOpen") === "true";
  });

  const togglePanel = () => {
    setPanelOpen((prev) => {
      const next = !prev;
      sessionStorage.setItem("propertiesPanelOpen", String(next));
      return next;
    });
  };

  useEffect(() => {
    fetchTaskDetail(taskId)
      .then((d) => setDetail(d))
      .catch(console.error);
  }, [taskId]);

  // Cmd+\ shortcut to toggle panel
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.metaKey && e.key === "\\") {
        e.preventDefault();
        togglePanel();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (!detail) {
    return <Skeleton lines={3} className="m-4" />;
  }

  const invocations: Invocation[] = detail.invocations || [];
  const activityFeed = buildActivityFeed(detail);

  function refresh() {
    fetchTaskDetail(taskId)
      .then((d) => setDetail(d))
      .catch(console.error);
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* Main content */}
      <div className="flex-1 p-4 space-y-6 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-mono font-semibold">{detail.linearIssueId}</h2>

          {/* Current status badge (non-interactive, panel handles changes) */}
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${getStatusBadgeClasses(detail.orcaStatus)}`}
          >
            {detail.orcaStatus === "ready" ? "queued" : detail.orcaStatus}
          </span>

          {detail.orcaStatus === "failed" && (
            <button
              onClick={() => {
                if (!window.confirm("Retry this task? It will be re-queued with fresh retry counters.")) return;
                retryTask(detail.linearIssueId)
                  .then(refresh)
                  .catch(console.error);
              }}
              className="text-xs px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 transition-colors"
            >
              Retry
            </button>
          )}

          <span className="flex-1" />

          {/* Properties toggle */}
          <button
            onClick={togglePanel}
            title="Toggle properties panel (⌘\)"
            className="text-xs px-2 py-1 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors"
          >
            Properties
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

        {/* Invocation history — timeline */}
        <div>
          <h3 className="text-sm text-gray-400 mb-3">Invocation History</h3>
          <InvocationTimeline
            invocations={invocations}
            taskId={taskId}
            onAborted={refresh}
          />
        </div>

        {/* Activity Feed */}
        {activityFeed.length > 0 && (
          <div>
            <h3 className="text-sm text-gray-400 mb-3">Activity</h3>
            <div className="space-y-2">
              {activityFeed.map((event, idx) => (
                <div key={idx} className="flex items-start gap-3 text-sm">
                  <span className="text-gray-500 w-4 shrink-0 text-center">{event.icon}</span>
                  <span className="text-gray-300 flex-1">{event.label}</span>
                  <span className="text-xs text-gray-500 whitespace-nowrap">{formatDate(event.time)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Properties panel overlay */}
      <PropertiesPanel
        task={detail}
        open={panelOpen}
        onClose={() => {
          setPanelOpen(false);
          sessionStorage.setItem("propertiesPanelOpen", "false");
        }}
        onStatusChange={refresh}
      />
    </div>
  );
}

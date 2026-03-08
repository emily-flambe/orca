import { useState, useEffect, useRef } from "react";
import type { TaskWithInvocations } from "../types";
import { fetchTaskDetail, retryTask, updateTaskStatus } from "../hooks/useApi";
import { getStatusBadgeClasses } from "./ui/StatusBadge";
import Skeleton from "./ui/Skeleton";
import EmptyState from "./ui/EmptyState";
import InvocationTimeline from "./InvocationTimeline";
import PropertiesPanel from "./PropertiesPanel";

interface Props {
  taskId: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const MANUAL_STATUSES = [
  { value: "backlog", label: "backlog", bg: "bg-gray-500/20 text-gray-500" },
  { value: "ready", label: "queued", bg: "bg-cyan-500/20 text-cyan-400" },
  { value: "done", label: "done", bg: "bg-green-500/20 text-green-400" },
] as const;

interface ActivityEvent {
  timestamp: string;
  label: string;
  dotClass: string;
}

function deriveActivityEvents(task: TaskWithInvocations): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const invocations = task.invocations || [];

  for (const inv of invocations) {
    events.push({
      timestamp: inv.startedAt,
      label: "Dispatched",
      dotClass: "bg-blue-500",
    });
    if (inv.endedAt) {
      let label = "Completed";
      let dotClass = "bg-green-500";
      if (inv.status === "failed") {
        label = "Failed";
        dotClass = "bg-red-500";
      } else if (inv.status === "timed_out") {
        label = "Timed out";
        dotClass = "bg-orange-500";
      }
      events.push({ timestamp: inv.endedAt, label, dotClass });
    }
  }

  if (task.prNumber != null) {
    // Find earliest invocation with phase "review", or fall back to createdAt
    const reviewInv = [...invocations]
      .filter((inv) => inv.phase === "review")
      .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())[0];
    events.push({
      timestamp: reviewInv ? reviewInv.startedAt : task.createdAt,
      label: "PR created",
      dotClass: "bg-purple-500",
    });
  }

  if (task.orcaStatus === "in_review") {
    events.push({
      timestamp: task.updatedAt,
      label: "Review started",
      dotClass: "bg-purple-400",
    });
  }

  if (task.orcaStatus === "changes_requested") {
    events.push({
      timestamp: task.updatedAt,
      label: "Changes requested",
      dotClass: "bg-orange-500",
    });
  }

  return events.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

export default function TaskDetail({ taskId }: Props) {
  const [detail, setDetail] = useState<TaskWithInvocations | null>(null);
  const [propertiesPanelOpen, setPropertiesPanelOpen] = useState(false);
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const statusMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchTaskDetail(taskId)
      .then((d) => setDetail(d))
      .catch(console.error);
  }, [taskId]);

  // Keyboard shortcut: Cmd+\ or Ctrl+\ toggles properties panel
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setPropertiesPanelOpen((open) => !open);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (statusMenuRef.current && !statusMenuRef.current.contains(e.target as Node)) {
        setShowStatusMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  if (!detail) {
    return <Skeleton lines={3} className="m-4" />;
  }

  const activityEvents = deriveActivityEvents(detail);

  return (
    <div className="relative flex-1 overflow-hidden">
      {/* Scrollable main content */}
      <div className="p-4 space-y-6 h-full overflow-y-auto">
        {/* Header */}
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-lg font-mono font-semibold">{detail.linearIssueId}</h2>
          <div className="relative" ref={statusMenuRef}>
            <button
              onClick={() => setShowStatusMenu(!showStatusMenu)}
              className={`text-xs px-2 py-0.5 rounded-full cursor-pointer hover:opacity-80 transition-colors ${getStatusBadgeClasses(detail.orcaStatus)}`}
            >
              {detail.orcaStatus === "ready" ? "queued" : detail.orcaStatus} &#9662;
            </button>
            {showStatusMenu && (
              <div className="absolute top-full left-0 mt-1 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-lg py-1 min-w-[120px]">
                {MANUAL_STATUSES.filter((s) => s.value !== detail.orcaStatus).map((s) => (
                  <button
                    key={s.value}
                    onClick={() => {
                      setShowStatusMenu(false);
                      updateTaskStatus(detail.linearIssueId, s.value)
                        .then(() => fetchTaskDetail(taskId))
                        .then((d) => setDetail(d))
                        .catch(console.error);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-700 transition-colors ${s.bg}`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {detail.orcaStatus === "failed" && (
            <button
              onClick={() => {
                if (!window.confirm("Retry this task? It will be re-queued with fresh retry counters.")) return;
                retryTask(detail.linearIssueId)
                  .then(() => fetchTaskDetail(taskId))
                  .then((d) => setDetail(d))
                  .catch(console.error);
              }}
              className="text-xs px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 transition-colors"
            >
              Retry
            </button>
          )}
          <div className="flex-1" />
          {/* Properties toggle button */}
          <button
            onClick={() => setPropertiesPanelOpen((open) => !open)}
            className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors ${
              propertiesPanelOpen
                ? "bg-gray-700 text-gray-100"
                : "bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700"
            }`}
            title="Toggle properties panel (⌘\)"
          >
            <span>⊞</span>
            <span>Properties</span>
            <span className="text-gray-600 text-[10px]">⌘\</span>
          </button>
        </div>

        {/* Agent prompt */}
        <div className="space-y-2">
          <label className="text-sm text-gray-400">Agent Prompt</label>
          <pre className="w-full bg-gray-900 border border-gray-700 rounded-lg p-3 text-sm text-gray-100 whitespace-pre-wrap">
            {detail.agentPrompt || <span className="text-gray-500 italic">No prompt (issue has no description)</span>}
          </pre>
        </div>

        {/* Invocation timeline */}
        <div>
          <h3 className="text-sm text-gray-400 mb-3">Invocations</h3>
          <InvocationTimeline
            invocations={detail.invocations || []}
            taskId={taskId}
            onInvocationAborted={() =>
              fetchTaskDetail(taskId)
                .then((d) => setDetail(d))
                .catch(console.error)
            }
          />
        </div>

        {/* Activity feed */}
        <div>
          <h3 className="text-sm text-gray-400 mb-3">Activity</h3>
          {activityEvents.length === 0 ? (
            <EmptyState message="No activity yet" />
          ) : (
            <div className="space-y-1">
              {activityEvents.map((event) => (
                <div key={`${event.timestamp}-${event.label}`} className="flex items-center gap-2.5 py-1">
                  <span className={`inline-flex rounded-full h-2 w-2 shrink-0 ${event.dotClass}`} />
                  <span className="text-xs text-gray-300">{event.label}</span>
                  <span className="flex-1" />
                  <span
                    className="text-xs text-gray-500 tabular-nums"
                    title={formatDate(event.timestamp)}
                  >
                    {formatRelative(event.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Properties panel — absolute inside relative wrapper */}
      <PropertiesPanel
        task={detail}
        open={propertiesPanelOpen}
        onClose={() => setPropertiesPanelOpen(false)}
        onTaskUpdated={(updated) => setDetail(updated)}
      />
    </div>
  );
}

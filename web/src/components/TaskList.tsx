// merge gate test
// merge gate test
import { useState, useEffect } from "react";
import type { Task } from "../types";
import { updateTaskStatus } from "../hooks/useApi";

/** Auto-hide done tasks after 15 minutes. */
const DONE_HIDE_MS = 15 * 60 * 1000;

interface Props {
  tasks: Task[];
  selectedTaskId: string | null;
  onSelect: (id: string) => void;
}

const STATUS_FILTERS = ["all", "ready", "running", "in_review", "awaiting_ci", "deploying", "changes_requested", "done", "failed"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const SORT_OPTIONS = ["priority", "status", "date", "project"] as const;
type SortOption = (typeof SORT_OPTIONS)[number];

function priorityColor(p: number): string {
  switch (p) {
    case 1: return "bg-red-500";
    case 2: return "bg-orange-500";
    case 3: return "bg-blue-500";
    case 4: return "bg-gray-500";
    default: return "bg-transparent border border-gray-600";
  }
}

function statusBadge(s: string): { bg: string; text: string } {
  switch (s) {
    case "done": return { bg: "bg-green-500/20 text-green-400", text: "done" };
    case "running": return { bg: "bg-blue-500/20 text-blue-400", text: "running" };
    case "ready": return { bg: "bg-cyan-500/20 text-cyan-400", text: "queued" };
    case "failed": return { bg: "bg-red-500/20 text-red-400", text: "failed" };
    case "dispatched": return { bg: "bg-gray-500/20 text-gray-400", text: "dispatched" };
    case "in_review": return { bg: "bg-purple-500/20 text-purple-400", text: "in review" };
    case "changes_requested": return { bg: "bg-orange-500/20 text-orange-400", text: "changes requested" };
    case "awaiting_ci": return { bg: "bg-yellow-500/20 text-yellow-400", text: "awaiting CI" };
    case "deploying": return { bg: "bg-teal-500/20 text-teal-400", text: "deploying" };
    case "backlog": return { bg: "bg-gray-500/20 text-gray-500", text: "backlog" };
    default: return { bg: "bg-gray-500/20 text-gray-400", text: s };
  }
}

const STATUS_ORDER: Record<string, number> = {
  running: 0, dispatched: 1, in_review: 2, awaiting_ci: 3, deploying: 4, changes_requested: 5, ready: 6, failed: 7, done: 8, backlog: 9,
};

const MANUAL_STATUSES = [
  { value: "backlog", label: "backlog", bg: "bg-gray-500/20 text-gray-500" },
  { value: "ready", label: "queued", bg: "bg-cyan-500/20 text-cyan-400" },
  { value: "done", label: "done", bg: "bg-green-500/20 text-green-400" },
] as const;

const STATUS_MENU_ATTR = "data-status-menu";

export default function TaskList({ tasks, selectedTaskId, onSelect }: Props) {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortOption>("priority");
  const [, tick] = useState(0);
  const [statusMenuTaskId, setStatusMenuTaskId] = useState<string | null>(null);

  // Re-render periodically so stale done tasks auto-hide
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Close status dropdown on click outside (uses data attribute instead of ref to handle dual layouts)
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest(`[${STATUS_MENU_ATTR}]`)) {
        setStatusMenuTaskId(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const now = Date.now();
  const filtered = (() => {
    const byStatus = filter === "all"
      ? tasks
      : tasks.filter((t) => t.orcaStatus === filter);

    // Always hide done tasks that have zero invocations (imported from Linear already complete)
    const withHistory = byStatus.filter((t) =>
      t.orcaStatus !== "done" || (t.invocationCount ?? 0) > 0,
    );

    // Show all done tasks when explicitly filtering for "done"
    if (filter === "done") return withHistory;

    // Otherwise hide done tasks older than 15 min (keep selected task visible)
    return withHistory.filter((t) =>
      t.orcaStatus !== "done" ||
      t.linearIssueId === selectedTaskId ||
      !t.doneAt ||
      now - new Date(t.doneAt).getTime() <= DONE_HIDE_MS,
    );
  })();

  const sorted = [...filtered].sort((a, b) => {
    if (sort === "priority") {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
    }
    if (sort === "status") {
      return (STATUS_ORDER[a.orcaStatus] ?? 9) - (STATUS_ORDER[b.orcaStatus] ?? 9);
    }
    if (sort === "project") {
      return (a.projectName ?? "").localeCompare(b.projectName ?? "");
    }
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  });

  const renderStatusDropdown = (task: Task, badge: { bg: string; text: string }) => (
    <div
      className="relative shrink-0"
      {...{ [STATUS_MENU_ATTR]: task.linearIssueId }}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          setStatusMenuTaskId(
            statusMenuTaskId === task.linearIssueId ? null : task.linearIssueId,
          );
        }}
        className={`text-xs px-2 py-0.5 rounded-full cursor-pointer hover:opacity-80 transition-colors ${badge.bg}`}
      >
        {badge.text} &#9662;
      </button>
      {statusMenuTaskId === task.linearIssueId && (
        <div className="absolute top-full right-0 mt-1 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-lg py-1 min-w-[120px]">
          {MANUAL_STATUSES.filter((s) => s.value !== task.orcaStatus).map((s) => (
            <button
              key={s.value}
              onClick={(e) => {
                e.stopPropagation();
                setStatusMenuTaskId(null);
                updateTaskStatus(task.linearIssueId, s.value).catch(console.error);
              }}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-700 transition-colors ${s.bg}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      {/* Filters */}
      <div className="p-2 md:p-3 border-b border-gray-800 flex flex-col sm:flex-row gap-2 sm:items-center">
        <div className="flex gap-1 overflow-x-auto scrollbar-hide whitespace-nowrap">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-1 text-xs rounded shrink-0 ${
                filter === f
                  ? "bg-gray-700 text-gray-100"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {f === "ready" ? "queued" : f === "awaiting_ci" ? "awaiting CI" : f}
            </button>
          ))}
        </div>
        <div className="sm:ml-auto flex gap-1">
          {SORT_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => setSort(s)}
              className={`px-2 py-1 text-xs rounded ${
                sort === s
                  ? "bg-gray-700 text-gray-100"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Task rows */}
      <div className="flex-1 overflow-y-auto">
        {sorted.map((task) => {
          const badge = statusBadge(task.orcaStatus);
          const isSelected = task.linearIssueId === selectedTaskId;
          return (
            <div
              key={task.linearIssueId}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(task.linearIssueId)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(task.linearIssueId); } }}
              className={`w-full text-left px-3 py-2.5 border-b border-gray-800/50 hover:bg-gray-800/50 transition-colors cursor-pointer ${
                isSelected ? "bg-gray-800" : ""
              }`}
            >
              {/* Desktop layout: single row */}
              <div className="hidden md:flex items-center gap-3">
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${priorityColor(task.priority)}`} />
                <span className="text-sm font-mono text-gray-400 shrink-0">
                  {task.linearIssueId}
                </span>
                {task.projectName && (
                  <span className="text-xs text-gray-500 shrink-0">
                    {task.projectName}
                  </span>
                )}
                <span className="text-sm text-gray-200 truncate flex-1">
                  {task.agentPrompt || "No prompt"}
                </span>
                {renderStatusDropdown(task, badge)}
              </div>

              {/* Mobile layout: two lines */}
              <div className="md:hidden">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${priorityColor(task.priority)}`} />
                  <span className="text-sm font-mono text-gray-400">{task.linearIssueId}</span>
                  {task.projectName && <span className="text-xs text-gray-500 truncate">{task.projectName}</span>}
                  <div className="ml-auto">
                    {renderStatusDropdown(task, badge)}
                  </div>
                </div>
                <p className="text-sm text-gray-200 truncate mt-1 pl-4">
                  {task.agentPrompt || "No prompt"}
                </p>
              </div>
            </div>
          );
        })}
        {sorted.length === 0 && (
          <div className="p-4 text-sm text-gray-500 text-center">No tasks</div>
        )}
      </div>
    </div>
  );
}

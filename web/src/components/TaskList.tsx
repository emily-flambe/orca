// merge gate test
// merge gate test
import { useState, useEffect } from "react";
import type { Task } from "../types";
import StatusMenuButton from "./StatusMenuButton";

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

const STATUS_ORDER: Record<string, number> = {
  running: 0, dispatched: 1, in_review: 2, awaiting_ci: 3, deploying: 4, changes_requested: 5, ready: 6, failed: 7, done: 8, backlog: 9,
};

export default function TaskList({ tasks, selectedTaskId, onSelect }: Props) {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortOption>("priority");
  const [, tick] = useState(0);

  // Re-render periodically so stale done tasks auto-hide
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
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

  return (
    <div className="flex flex-col h-full">
      {/* Filters */}
      <div className="p-2 md:p-3 border-b border-gray-800 flex flex-col md:flex-row gap-2 md:items-center">
        <div className="flex gap-1 flex-wrap">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-1.5 md:py-1 text-xs rounded ${
                filter === f
                  ? "bg-gray-700 text-gray-100"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {f === "ready" ? "queued" : f === "awaiting_ci" ? (
                <><span className="hidden md:inline">awaiting </span>CI</>
              ) : f === "changes_requested" ? (
                <><span className="md:hidden">changes</span><span className="hidden md:inline">{f}</span></>
              ) : f}
            </button>
          ))}
        </div>
        <div className="md:ml-auto flex gap-1">
          {SORT_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => setSort(s)}
              className={`px-2 py-1.5 md:py-1 text-xs rounded ${
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
          const isSelected = task.linearIssueId === selectedTaskId;
          return (
            <div
              key={task.linearIssueId}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(task.linearIssueId)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(task.linearIssueId); } }}
              className={`w-full text-left px-3 py-2.5 md:py-2.5 border-b border-gray-800/50 hover:bg-gray-800/50 transition-colors cursor-pointer ${
                isSelected ? "bg-gray-800" : ""
              }`}
            >
              {/* Desktop row */}
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
                  {task.agentPrompt ? task.agentPrompt.slice(0, 60) : "No prompt"}
                </span>
                <StatusMenuButton status={task.orcaStatus} taskId={task.linearIssueId} />
              </div>
              {/* Mobile row */}
              <div className="flex md:hidden flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${priorityColor(task.priority)}`} />
                  <span className="text-xs font-mono text-gray-400">
                    {task.linearIssueId}
                  </span>
                  {task.projectName && (
                    <span className="text-xs text-gray-600">
                      {task.projectName}
                    </span>
                  )}
                  <StatusMenuButton status={task.orcaStatus} taskId={task.linearIssueId} mobile />
                </div>
                <span className="text-sm text-gray-200 leading-snug line-clamp-3">
                  {task.agentPrompt || <span className="text-gray-500 italic">No prompt</span>}
                </span>
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

// merge gate test
// merge gate test
import { useState, useEffect } from "react";
import type { Task } from "../types";

/** Auto-hide done tasks after 15 minutes. */
const DONE_HIDE_MS = 15 * 60 * 1000;

interface Props {
  tasks: Task[];
  selectedTaskId: string | null;
  onSelect: (id: string) => void;
}

const STATUS_FILTERS = ["all", "ready", "running", "in_review", "deploying", "changes_requested", "done", "failed"] as const;
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
    case "ready": return { bg: "bg-cyan-500/20 text-cyan-400", text: "ready" };
    case "failed": return { bg: "bg-red-500/20 text-red-400", text: "failed" };
    case "dispatched": return { bg: "bg-gray-500/20 text-gray-400", text: "dispatched" };
    case "in_review": return { bg: "bg-purple-500/20 text-purple-400", text: "in review" };
    case "changes_requested": return { bg: "bg-orange-500/20 text-orange-400", text: "changes requested" };
    case "deploying": return { bg: "bg-teal-500/20 text-teal-400", text: "deploying" };
    case "backlog": return { bg: "bg-gray-500/20 text-gray-500", text: "backlog" };
    default: return { bg: "bg-gray-500/20 text-gray-400", text: s };
  }
}

const STATUS_ORDER: Record<string, number> = {
  running: 0, dispatched: 1, in_review: 2, deploying: 3, changes_requested: 4, ready: 5, failed: 6, done: 7, backlog: 8,
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

    // Show all done tasks when explicitly filtering for "done"
    if (filter === "done") return byStatus;

    // Otherwise hide done tasks older than 15 min (keep selected task visible)
    return byStatus.filter((t) =>
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
      <div className="p-3 border-b border-gray-800 flex gap-2 flex-wrap items-center">
        <div className="flex gap-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-1 text-xs rounded ${
                filter === f
                  ? "bg-gray-700 text-gray-100"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-1">
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
            <button
              key={task.linearIssueId}
              onClick={() => onSelect(task.linearIssueId)}
              className={`w-full text-left px-3 py-2.5 flex items-center gap-3 border-b border-gray-800/50 hover:bg-gray-800/50 transition-colors ${
                isSelected ? "bg-gray-800" : ""
              }`}
            >
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
              <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${badge.bg}`}>
                {badge.text}
              </span>
            </button>
          );
        })}
        {sorted.length === 0 && (
          <div className="p-4 text-sm text-gray-500 text-center">No tasks</div>
        )}
      </div>
    </div>
  );
}

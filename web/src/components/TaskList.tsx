import { useState, useEffect, useRef } from "react";
import type { Task } from "../types";
import { updateTaskStatus } from "../hooks/useApi";

/** Auto-hide done tasks after 15 minutes. */
const DONE_HIDE_MS = 15 * 60 * 1000;

interface Props {
  tasks: Task[];
  selectedTaskId: string | null;
  onSelect: (id: string) => void;
}

const STATUS_FILTERS = [
  { value: "ready", label: "queued" },
  { value: "running", label: "running" },
  { value: "dispatched", label: "dispatched" },
  { value: "in_review", label: "in review" },
  { value: "awaiting_ci", label: "awaiting CI" },
  { value: "deploying", label: "deploying" },
  { value: "changes_requested", label: "changes requested" },
  { value: "done", label: "done" },
  { value: "failed", label: "failed" },
] as const;
type FilterStatus = (typeof STATUS_FILTERS)[number]["value"];
const ALL_FILTER_VALUES = STATUS_FILTERS.map((f) => f.value) as FilterStatus[];

const SORT_OPTIONS = ["priority", "status", "date", "project"] as const;
type SortOption = (typeof SORT_OPTIONS)[number];

function priorityDot(p: number): { color: string; label: string; title: string } {
  switch (p) {
    case 1: return { color: "bg-red-500 text-white", label: "P0", title: "P0 (urgent)" };
    case 2: return { color: "bg-orange-500 text-white", label: "P1", title: "P1 (high)" };
    case 3: return { color: "bg-blue-500 text-white", label: "P2", title: "P2 (medium)" };
    case 4: return { color: "bg-gray-500 text-white", label: "P3", title: "P3 (low)" };
    default: return { color: "bg-transparent border border-gray-600 text-gray-500", label: "P4", title: "P4 (no urgency set)" };
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

export default function TaskList({ tasks, selectedTaskId, onSelect }: Props) {
  const [selectedStatuses, setSelectedStatuses] = useState<Set<FilterStatus>>(
    () => new Set(ALL_FILTER_VALUES),
  );
  const [sort, setSort] = useState<SortOption>("priority");

  function toggleStatus(status: FilterStatus) {
    setSelectedStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  }
  const [, tick] = useState(0);
  const [statusMenuTaskId, setStatusMenuTaskId] = useState<string | null>(null);
  const statusMenuRef = useRef<HTMLDivElement>(null);

  // Re-render periodically so stale done tasks auto-hide
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (statusMenuRef.current && !statusMenuRef.current.contains(e.target as Node)) {
        setStatusMenuTaskId(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const now = Date.now();
  const filtered = (() => {
    const byStatus = tasks.filter((t) =>
      (selectedStatuses as ReadonlySet<string>).has(t.orcaStatus),
    );

    // Always hide done tasks that have zero invocations (imported from Linear already complete)
    const withHistory = byStatus.filter((t) =>
      t.orcaStatus !== "done" || (t.invocationCount ?? 0) > 0,
    );

    // When only "done" is selected, show all done tasks regardless of age
    // (equivalent to the old explicit "done" filter behavior)
    if (selectedStatuses.size === 1 && selectedStatuses.has("done")) return withHistory;

    // Hide done tasks older than 15 min (keep selected task visible)
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
      <div className="px-3 pt-3 pb-2 border-b border-gray-800 space-y-2">
        {/* Status filters - horizontally scrollable */}
        <div className="overflow-x-auto">
          <div className="flex gap-1 flex-nowrap min-w-max pb-1">
            {STATUS_FILTERS.map((f) => {
              const active = selectedStatuses.has(f.value);
              return (
                <button
                  key={f.value}
                  onClick={() => toggleStatus(f.value)}
                  className={`px-2.5 py-1 text-xs rounded whitespace-nowrap transition-colors ${
                    active
                      ? "bg-gray-700 text-gray-100"
                      : "text-gray-600 hover:text-gray-400 line-through"
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>
        {/* Sort options */}
        <div className="flex gap-1 overflow-x-auto">
          <span className="text-xs text-gray-600 self-center shrink-0">sort:</span>
          {SORT_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => setSort(s)}
              className={`px-2 py-0.5 text-xs rounded whitespace-nowrap ${
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
              className={`w-full text-left px-3 py-3 flex flex-col gap-1 border-b border-gray-800/50 hover:bg-gray-800/50 active:bg-gray-800 transition-colors cursor-pointer min-h-[60px] ${
                isSelected ? "bg-gray-800" : ""
              }`}
            >
              {/* Top row: priority + ID + project + status */}
              <div className="flex items-center gap-2">
                <span
                  title={priorityDot(task.priority).title}
                  className={`w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold ${priorityDot(task.priority).color}`}
                >
                  {priorityDot(task.priority).label}
                </span>
                <span className="text-xs font-mono text-gray-400 shrink-0">
                  {task.linearIssueId}
                </span>
                {task.projectName && (
                  <span className="text-xs text-gray-500 truncate">
                    {task.projectName}
                  </span>
                )}
                <div
                  className="relative shrink-0 ml-auto"
                  ref={statusMenuTaskId === task.linearIssueId ? statusMenuRef : undefined}
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
                          className={`w-full text-left px-3 py-2 text-xs hover:bg-gray-700 transition-colors ${s.bg}`}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {/* Title row */}
              <span className="text-sm text-gray-200 leading-snug line-clamp-3 md:line-clamp-2">
                {task.agentPrompt || "No prompt"}
              </span>
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

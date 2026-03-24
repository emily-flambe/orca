import { useState, useEffect, useRef, useMemo } from "react";
import type { Task } from "../types";
import { updateTaskStatus } from "../hooks/useApi";
import PriorityDot from "./ui/PriorityDot";
import { getStatusBadgeClasses, getStatusDisplayText } from "./ui/StatusBadge";
import EmptyState from "./ui/EmptyState";
import Badge from "./ui/Badge";
import { MANUAL_STATUSES } from "../constants.js";

/** Auto-hide done tasks after 15 minutes. */
const DONE_HIDE_MS = 15 * 60 * 1000;

/** Inline SVG PR state icon, colored by state. */
function PrStateIcon({
  state,
}: {
  state: "draft" | "open" | "merged" | "closed" | null | undefined;
}) {
  const color =
    state === "merged"
      ? "#8250df"
      : state === "closed"
        ? "#cf222e"
        : state === "draft"
          ? "#6e7781"
          : "#1a7f37";
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill={color}
      aria-label={state ?? "open"}
    >
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}

interface ToastCallbacks {
  success: (msg: string) => void;
  error: (msg: string) => void;
}

interface Props {
  tasks: Task[];
  selectedTaskId: string | null;
  onSelect: (id: string) => void;
  onToast?: ToastCallbacks;
}

const STATUS_FILTERS = [
  { value: "backlog", label: "backlog" },
  { value: "ready", label: "queued" },
  { value: "running", label: "working" },
  { value: "in_review", label: "reviewing" },
  { value: "awaiting_ci", label: "awaiting CI" },
  { value: "deploying", label: "deploying" },
  { value: "changes_requested", label: "fixing" },
  { value: "done", label: "done" },
  { value: "canceled", label: "canceled" },
  { value: "failed", label: "failed" },
] as const;
type FilterStatus = (typeof STATUS_FILTERS)[number]["value"];
const ALL_FILTER_VALUES = STATUS_FILTERS.map((f) => f.value) as FilterStatus[];

const SORT_OPTIONS = ["priority", "status", "date", "project"] as const;
type SortOption = (typeof SORT_OPTIONS)[number];

function statusFilterActiveStyle(value: FilterStatus): string {
  switch (value) {
    case "done":
      return "bg-green-500/20 text-green-400 border border-green-500/30";
    case "running":
      return "bg-blue-500/20 text-blue-400 border border-blue-500/30";
    case "ready":
      return "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30";
    case "failed":
      return "bg-red-500/20 text-red-400 border border-red-500/30";
    case "in_review":
      return "bg-purple-500/20 text-purple-400 border border-purple-500/30";
    case "changes_requested":
      return "bg-orange-500/20 text-orange-400 border border-orange-500/30";
    case "awaiting_ci":
      return "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30";
    case "deploying":
      return "bg-teal-500/20 text-teal-400 border border-teal-500/30";
    case "backlog":
      return "bg-gray-500/20 text-gray-500 border border-gray-700";
    default:
      return "bg-gray-700 text-gray-100 border border-gray-600";
  }
}

const STATUS_ORDER: Record<string, number> = {
  running: 0,
  in_review: 1,
  awaiting_ci: 2,
  deploying: 3,
  changes_requested: 4,
  ready: 5,
  failed: 6,
  done: 7,
  backlog: 8,
};

type SortDirection = "asc" | "desc";
interface SortState {
  option: SortOption | null;
  direction: SortDirection;
}

export default function TaskList({
  tasks,
  selectedTaskId,
  onSelect,
  onToast,
}: Props) {
  const [selectedStatuses, setSelectedStatuses] = useState<Set<FilterStatus>>(
    () => new Set(ALL_FILTER_VALUES.filter((v) => v !== "backlog")),
  );
  const [sortState, setSortState] = useState<SortState>({
    option: "status",
    direction: "asc",
  });

  function handleSortClick(option: SortOption) {
    setSortState((prev) => {
      if (prev.option !== option) return { option, direction: "asc" };
      if (prev.direction === "asc") return { option, direction: "desc" };
      return { option: null, direction: "asc" };
    });
  }

  // hiddenProjects: empty = show all, otherwise hide listed project names
  const [hiddenProjects, setHiddenProjects] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");

  const allProjects = useMemo(() => {
    const ps = new Set<string>();
    for (const t of tasks) if (t.projectName) ps.add(t.projectName);
    return [...ps].sort();
  }, [tasks]);

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

  function toggleProject(p: string) {
    setHiddenProjects((prev) => {
      const next = new Set(prev);
      if (next.has(p)) {
        next.delete(p);
      } else {
        next.add(p);
      }
      return next;
    });
  }

  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false);
  const statusDropdownRef = useRef<HTMLDivElement>(null);
  const statusFilterTriggerRef = useRef<HTMLButtonElement>(null);
  const [, tick] = useState(0);
  const [statusMenuTaskId, setStatusMenuTaskId] = useState<string | null>(null);
  const statusMenuRef = useRef<HTMLDivElement>(null);
  const statusMenuTriggerRef = useRef<HTMLButtonElement>(null);

  // Focus first menu item when the per-task status menu opens
  useEffect(() => {
    if (!statusMenuTaskId || !statusMenuRef.current) return;
    const first =
      statusMenuRef.current.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, [statusMenuTaskId]);

  // Re-render periodically so stale done tasks auto-hide
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        statusMenuRef.current &&
        !statusMenuRef.current.contains(e.target as Node)
      ) {
        setStatusMenuTaskId(null);
      }
      if (
        statusDropdownRef.current &&
        !statusDropdownRef.current.contains(e.target as Node)
      ) {
        setStatusDropdownOpen(false);
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

    const byProject =
      hiddenProjects.size === 0
        ? byStatus
        : byStatus.filter((t) => !hiddenProjects.has(t.projectName ?? ""));

    // Always hide done tasks that have zero invocations (imported from Linear already complete)
    const withHistory = byProject.filter(
      (t) => t.orcaStatus !== "done" || (t.invocationCount ?? 0) > 0,
    );

    // When only "done" is selected, show all done tasks regardless of age
    if (selectedStatuses.size === 1 && selectedStatuses.has("done"))
      return withHistory;

    // Hide done tasks older than 15 min (keep selected task visible)
    const byAge = withHistory.filter(
      (t) =>
        t.orcaStatus !== "done" ||
        t.linearIssueId === selectedTaskId ||
        !t.doneAt ||
        now - new Date(t.doneAt).getTime() <= DONE_HIDE_MS,
    );

    if (!searchQuery.trim()) return byAge;
    const q = searchQuery.trim().toLowerCase();
    return byAge.filter(
      (t) =>
        t.linearIssueId.toLowerCase().includes(q) ||
        (t.agentPrompt ?? "").toLowerCase().includes(q),
    );
  })();

  const sorted = [...filtered].sort((a, b) => {
    const { option, direction } = sortState;
    if (option === null) return 0;
    let cmp = 0;
    if (option === "priority") {
      if (a.priority !== b.priority) {
        cmp = a.priority - b.priority;
      } else {
        cmp = (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
      }
    } else if (option === "status") {
      cmp =
        (STATUS_ORDER[a.orcaStatus] ?? 9) - (STATUS_ORDER[b.orcaStatus] ?? 9);
    } else if (option === "project") {
      cmp = (a.projectName ?? "").localeCompare(b.projectName ?? "");
    } else {
      // date
      cmp = (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
    }
    return direction === "desc" ? -cmp : cmp;
  });

  function handleExport() {
    const fields: (keyof Task)[] = [
      "linearIssueId",
      "orcaStatus",
      "taskType",
      "priority",
      "projectName",
      "prBranchName",
      "prNumber",
      "retryCount",
      "createdAt",
      "updatedAt",
      "doneAt",
    ];

    function escapeCell(value: unknown): string {
      const str = value === null || value === undefined ? "" : String(value);
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }

    const header = fields.join(",");
    const rows = sorted.map((task) =>
      fields.map((f) => escapeCell(task[f])).join(","),
    );
    const csv = [header, ...rows].join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `orca-tasks-${new Date().toISOString().replace(/:/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Count tasks per status (from all tasks, ignoring filters)
  const statusCounts = useMemo(() => {
    const counts: Partial<Record<FilterStatus, number>> = {};
    for (const t of tasks) {
      const s = t.orcaStatus as FilterStatus;
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return counts;
  }, [tasks]);

  // Count tasks per project (from all tasks)
  const projectCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tasks) {
      if (t.projectName)
        counts[t.projectName] = (counts[t.projectName] ?? 0) + 1;
    }
    return counts;
  }, [tasks]);

  const allStatusesSelected = ALL_FILTER_VALUES.every((v) =>
    selectedStatuses.has(v),
  );

  return (
    <div className="flex flex-col h-full">
      {/* Filters */}
      <div className="px-3 pt-3 pb-2 border-b border-gray-800 space-y-3">
        {/* Search input */}
        <input
          type="text"
          placeholder="Search by ID or title…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full bg-gray-800/60 border border-gray-700 rounded-md px-2 py-1 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-gray-500 transition-colors"
        />

        {/* Status filter dropdown */}
        <div className="flex items-center gap-2" ref={statusDropdownRef}>
          <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider shrink-0">
            Status
          </span>
          <div className="relative flex-1">
            <button
              ref={statusFilterTriggerRef}
              id="status-filter-btn"
              aria-haspopup="listbox"
              aria-expanded={statusDropdownOpen}
              aria-controls="status-filter-menu"
              aria-label="Filter by status"
              onClick={() => setStatusDropdownOpen((o) => !o)}
              className="flex items-center justify-between w-full px-2 py-1 text-xs bg-gray-800/60 border border-gray-700 rounded-md hover:border-gray-600 transition-colors text-gray-300 gap-1"
            >
              <span className="truncate">
                {selectedStatuses.size === ALL_FILTER_VALUES.length
                  ? "all statuses"
                  : selectedStatuses.size === 0
                    ? "none"
                    : selectedStatuses.size === 1
                      ? (STATUS_FILTERS.find((f) =>
                          selectedStatuses.has(f.value),
                        )?.label ?? "1 status")
                      : `${selectedStatuses.size} of ${ALL_FILTER_VALUES.length}`}
              </span>
              <svg
                className={`w-3 h-3 shrink-0 text-gray-500 transition-transform ${statusDropdownOpen ? "rotate-180" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>
            {statusDropdownOpen && (
              <div
                id="status-filter-menu"
                role="listbox"
                aria-multiselectable="true"
                className="absolute top-full left-0 mt-1 z-50 bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1 min-w-full w-48"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setStatusDropdownOpen(false);
                    statusFilterTriggerRef.current?.focus();
                    return;
                  }
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    const items = Array.from(
                      e.currentTarget.querySelectorAll<HTMLElement>(
                        '[role="option"]',
                      ),
                    );
                    const idx = items.indexOf(
                      document.activeElement as HTMLElement,
                    );
                    if (e.key === "ArrowDown") {
                      items[idx === -1 ? 0 : (idx + 1) % items.length]?.focus();
                    } else {
                      items[
                        idx === -1
                          ? items.length - 1
                          : (idx - 1 + items.length) % items.length
                      ]?.focus();
                    }
                  }
                }}
              >
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-800 mb-1">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                    Filter by status
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      role="menuitem"
                      tabIndex={-1}
                      onClick={() =>
                        setSelectedStatuses(new Set(ALL_FILTER_VALUES))
                      }
                      className={`text-[10px] transition-colors ${allStatusesSelected ? "text-gray-700 cursor-default" : "text-gray-500 hover:text-gray-300"}`}
                      disabled={allStatusesSelected}
                    >
                      all
                    </button>
                    <button
                      role="menuitem"
                      tabIndex={-1}
                      onClick={() => setSelectedStatuses(new Set())}
                      className={`text-[10px] transition-colors ${selectedStatuses.size === 0 ? "text-gray-700 cursor-default" : "text-gray-500 hover:text-gray-300"}`}
                      disabled={selectedStatuses.size === 0}
                    >
                      none
                    </button>
                  </div>
                </div>
                {STATUS_FILTERS.map((f) => {
                  const active = selectedStatuses.has(f.value);
                  const count = statusCounts[f.value] ?? 0;
                  return (
                    <button
                      key={f.value}
                      role="option"
                      aria-selected={active}
                      onClick={() => toggleStatus(f.value)}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-gray-800 transition-colors"
                    >
                      <span
                        className={`w-3 h-3 rounded-sm border flex items-center justify-center shrink-0 ${active ? "bg-gray-400 border-gray-400" : "border-gray-600"}`}
                      >
                        {active && (
                          <svg
                            className="w-2 h-2 text-gray-900"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={3}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                        )}
                      </span>
                      <span
                        className={`flex-1 text-left rounded-full px-1.5 py-0.5 ${active ? statusFilterActiveStyle(f.value) : "text-gray-600 line-through"}`}
                      >
                        {f.label}
                      </span>
                      {count > 0 && (
                        <span
                          className={`text-[10px] tabular-nums ${active ? "text-gray-500" : "text-gray-700"}`}
                        >
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Project filter — only shown when multiple projects exist */}
        {allProjects.length > 1 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
                Project
              </span>
              <button
                onClick={() => setHiddenProjects(new Set())}
                className={`text-[11px] transition-colors ${hiddenProjects.size === 0 ? "text-gray-700 cursor-default" : "text-gray-500 hover:text-gray-300"}`}
                disabled={hiddenProjects.size === 0}
              >
                all
              </button>
            </div>
            <div className="overflow-x-auto scrollbar-none">
              <div className="flex gap-1 flex-nowrap min-w-max">
                {allProjects.map((p) => {
                  const active = !hiddenProjects.has(p);
                  const count = projectCounts[p] ?? 0;
                  return (
                    <button
                      key={p}
                      onClick={() => toggleProject(p)}
                      title={active ? `Hide ${p}` : `Show ${p}`}
                      className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded-full whitespace-nowrap transition-colors ${
                        active
                          ? "bg-gray-700/60 text-gray-300 border border-gray-600"
                          : "text-gray-700 hover:text-gray-500 line-through"
                      }`}
                    >
                      {p}
                      {count > 0 && (
                        <span
                          className={`text-[10px] tabular-nums leading-none ${active ? "opacity-60" : "opacity-40"}`}
                        >
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Sort */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider shrink-0">
            Sort
          </span>
          <div className="flex gap-1 overflow-x-auto scrollbar-none">
            {SORT_OPTIONS.map((s) => {
              const isActive = sortState.option === s;
              const label = isActive
                ? s + (sortState.direction === "asc" ? " ↑" : " ↓")
                : s;
              return (
                <button
                  key={s}
                  onClick={() => handleSortClick(s)}
                  className={`px-2 py-0.5 text-xs rounded-full whitespace-nowrap transition-colors ${
                    isActive
                      ? "bg-gray-700 text-gray-100 border border-gray-600"
                      : "text-gray-600 hover:text-gray-400"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Export */}
        <div className="flex justify-end">
          <button
            onClick={handleExport}
            className="bg-gray-600 hover:bg-gray-700 text-white px-3 py-1 rounded text-sm"
          >
            Export
          </button>
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
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(task.linearIssueId);
                }
              }}
              className={`w-full text-left px-3 py-3 flex flex-col gap-1 border-b border-gray-800/50 hover:bg-gray-800/50 active:bg-gray-800 transition-colors cursor-pointer ${
                isSelected ? "bg-gray-800" : ""
              }`}
            >
              {/* Top row: priority + ID + status */}
              <div className="flex items-center gap-2">
                <PriorityDot priority={task.priority} />
                <span className="text-xs font-mono text-gray-400 shrink-0">
                  {task.linearIssueId}
                </span>
                {(task.taskType === "cron_claude" ||
                  task.taskType === "cron_shell") && (
                  <Badge className="shrink-0 !text-[10px] !px-1.5 !py-0 !text-orange-400 !bg-orange-900/20 !border-orange-700/40">
                    cron
                  </Badge>
                )}
                {task.projectName && (
                  <Badge className="shrink-0 !text-[10px] !px-1.5 !py-0 !text-gray-500 !bg-transparent !border-gray-700">
                    {task.projectName}
                  </Badge>
                )}
                <div
                  className="relative shrink-0 ml-auto"
                  ref={
                    statusMenuTaskId === task.linearIssueId
                      ? statusMenuRef
                      : undefined
                  }
                >
                  <button
                    ref={
                      statusMenuTaskId === task.linearIssueId
                        ? statusMenuTriggerRef
                        : undefined
                    }
                    aria-haspopup="menu"
                    aria-expanded={statusMenuTaskId === task.linearIssueId}
                    aria-label={`Change status: ${getStatusDisplayText(task.orcaStatus)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setStatusMenuTaskId(
                        statusMenuTaskId === task.linearIssueId
                          ? null
                          : task.linearIssueId,
                      );
                    }}
                    className={`text-xs px-2 py-0.5 rounded-full cursor-pointer hover:opacity-80 transition-colors ${getStatusBadgeClasses(task.orcaStatus)}`}
                  >
                    {getStatusDisplayText(task.orcaStatus)} &#9662;
                  </button>
                  {statusMenuTaskId === task.linearIssueId && (
                    <div
                      role="menu"
                      className="absolute top-full right-0 mt-1 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-lg py-1 min-w-[120px]"
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          setStatusMenuTaskId(null);
                          statusMenuTriggerRef.current?.focus();
                          return;
                        }
                        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                          e.preventDefault();
                          const items = Array.from(
                            e.currentTarget.querySelectorAll<HTMLElement>(
                              '[role="menuitem"]',
                            ),
                          );
                          const idx = items.indexOf(
                            document.activeElement as HTMLElement,
                          );
                          if (e.key === "ArrowDown") {
                            items[
                              idx === -1 ? 0 : (idx + 1) % items.length
                            ]?.focus();
                          } else {
                            items[
                              idx === -1
                                ? items.length - 1
                                : (idx - 1 + items.length) % items.length
                            ]?.focus();
                          }
                        }
                      }}
                    >
                      {MANUAL_STATUSES.filter(
                        (s) => s.value !== task.orcaStatus,
                      ).map((s) => (
                        <button
                          key={s.value}
                          role="menuitem"
                          tabIndex={-1}
                          onClick={(e) => {
                            e.stopPropagation();
                            setStatusMenuTaskId(null);
                            updateTaskStatus(task.linearIssueId, s.value)
                              .then(() => {
                                onToast?.success(
                                  `Status updated to ${s.label}`,
                                );
                              })
                              .catch((err: unknown) => {
                                onToast?.error(
                                  err instanceof Error
                                    ? err.message
                                    : "Failed to update status",
                                );
                              });
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
              {/* Title row — full on mobile, clamped on desktop */}
              <span className="text-sm text-gray-200 leading-snug line-clamp-4 md:line-clamp-2 pl-[18px]">
                {task.agentPrompt
                  ? task.agentPrompt.slice(0, 300)
                  : "No prompt"}
              </span>
              {task.prNumber != null && (
                <span className="flex items-center gap-1 pl-[18px]">
                  <PrStateIcon state={task.prState} />
                  {task.prUrl ? (
                    <a
                      href={task.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-xs font-mono hover:underline"
                      style={{
                        color:
                          task.prState === "merged"
                            ? "#8250df"
                            : task.prState === "closed"
                              ? "#cf222e"
                              : task.prState === "draft"
                                ? "#6e7781"
                                : "#1a7f37",
                      }}
                    >
                      #{task.prNumber}
                    </a>
                  ) : (
                    <span className="text-xs font-mono text-gray-500">
                      #{task.prNumber}
                    </span>
                  )}
                </span>
              )}
              {task.orcaStatus === "failed" && task.lastFailureReason && (
                <span
                  className="text-xs text-red-400/80 leading-snug pl-[18px] truncate"
                  title={task.lastFailureReason}
                >
                  {task.lastFailedPhase ? `[${task.lastFailedPhase}] ` : ""}
                  {task.lastFailureReason.slice(0, 120)}
                </span>
              )}
            </div>
          );
        })}
        {sorted.length === 0 && <EmptyState message="No tasks" />}
      </div>
    </div>
  );
}

import { useState, useRef, useEffect } from "react";
import type { TaskWithInvocations } from "../types";
import { fetchTaskDetail, updateTaskStatus } from "../hooks/useApi";
import { getStatusBadgeClasses } from "./ui/StatusBadge";

interface Props {
  task: TaskWithInvocations;
  isOpen: boolean;
  onToggle: () => void;
  onTaskUpdate: (updated: TaskWithInvocations) => void;
}

const MANUAL_STATUSES = [
  { value: "backlog", label: "backlog", bg: "bg-gray-500/20 text-gray-500" },
  { value: "ready", label: "queued", bg: "bg-cyan-500/20 text-cyan-400" },
  { value: "done", label: "done", bg: "bg-green-500/20 text-green-400" },
] as const;

const PRIORITY_LABELS: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Normal",
  4: "Low",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatDurationMs(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 border-b border-gray-800 last:border-b-0">
      <span className="text-xs text-gray-500 uppercase tracking-wide">{label}</span>
      <div className="text-sm text-gray-200">{children}</div>
    </div>
  );
}

export default function PropertiesPanel({ task, isOpen, onToggle, onTaskUpdate }: Props) {
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const statusMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (statusMenuRef.current && !statusMenuRef.current.contains(e.target as Node)) {
        setShowStatusMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Derived fields
  const sortedInvocations = [...task.invocations].sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  );
  const latestInvocation = sortedInvocations[sortedInvocations.length - 1] ?? null;
  const phase = latestInvocation?.phase ?? null;

  const totalCost = task.invocations.reduce((acc, inv) => {
    return acc + (inv.costUsd ?? 0);
  }, 0);

  const totalDurationMs = task.invocations.reduce((acc, inv) => {
    if (!inv.endedAt) return acc;
    return acc + (new Date(inv.endedAt).getTime() - new Date(inv.startedAt).getTime());
  }, 0);

  const priorityLabel = PRIORITY_LABELS[task.priority] ?? String(task.priority);

  const hasCost = task.invocations.some((inv) => inv.costUsd != null);
  const hasDuration = task.invocations.some((inv) => inv.endedAt != null);

  return (
    <div
      className="flex-shrink-0 h-full overflow-y-auto border-l border-gray-800 bg-gray-900 transition-all duration-200"
      style={{
        width: isOpen ? "320px" : "0px",
        opacity: isOpen ? 1 : 0,
        pointerEvents: isOpen ? "auto" : "none",
      }}
    >
      <div className="w-[320px]">
        {/* Panel header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Properties</span>
          <button
            onClick={onToggle}
            className="text-gray-500 hover:text-gray-300 transition-colors text-sm"
            title="Close panel"
          >
            ✕
          </button>
        </div>

        {/* Properties */}
        <div className="px-4 py-2">
          {/* Status */}
          <Row label="Status">
            <div className="relative" ref={statusMenuRef}>
              <button
                onClick={() => setShowStatusMenu(!showStatusMenu)}
                className={`text-xs px-2 py-0.5 rounded-full cursor-pointer hover:opacity-80 transition-colors ${getStatusBadgeClasses(task.orcaStatus)}`}
              >
                {task.orcaStatus === "ready" ? "queued" : task.orcaStatus} &#9662;
              </button>
              {showStatusMenu && (
                <div className="absolute top-full left-0 mt-1 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-lg py-1 min-w-[120px]">
                  {MANUAL_STATUSES.filter((s) => s.value !== task.orcaStatus).map((s) => (
                    <button
                      key={s.value}
                      onClick={() => {
                        setShowStatusMenu(false);
                        updateTaskStatus(task.linearIssueId, s.value)
                          .then(() => fetchTaskDetail(task.linearIssueId))
                          .then((d) => onTaskUpdate(d))
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
          </Row>

          {/* Priority */}
          <Row label="Priority">
            <span className="text-gray-200">{priorityLabel}</span>
          </Row>

          {/* Phase */}
          <Row label="Phase">
            {phase ? (
              <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">{phase}</span>
            ) : (
              <span className="text-gray-500">—</span>
            )}
          </Row>

          {/* PR */}
          <Row label="PR">
            {task.prNumber != null ? (
              <span className="text-gray-200 font-mono">#{task.prNumber}</span>
            ) : (
              <span className="text-gray-500">—</span>
            )}
          </Row>

          {/* Branch */}
          <Row label="Branch">
            {task.prBranchName ? (
              <span className="text-gray-200 font-mono text-xs break-all">{task.prBranchName}</span>
            ) : (
              <span className="text-gray-500">—</span>
            )}
          </Row>

          {/* Review cycles */}
          <Row label="Review cycles">
            <span className="text-gray-200">{task.reviewCycleCount}</span>
          </Row>

          {/* Total cost */}
          <Row label="Total cost">
            {hasCost ? (
              <span className="text-gray-200 tabular-nums font-mono">${totalCost.toFixed(2)}</span>
            ) : (
              <span className="text-gray-500">—</span>
            )}
          </Row>

          {/* Total duration */}
          <Row label="Total duration">
            {hasDuration ? (
              <span className="text-gray-200 tabular-nums">{formatDurationMs(totalDurationMs)}</span>
            ) : (
              <span className="text-gray-500">—</span>
            )}
          </Row>

          {/* Created */}
          <Row label="Created">
            <span className="text-gray-300 text-xs">{formatDate(task.createdAt)}</span>
          </Row>

          {/* Updated */}
          <Row label="Updated">
            <span className="text-gray-300 text-xs">{formatDate(task.updatedAt)}</span>
          </Row>

          {/* Linear issue */}
          <Row label="Linear issue">
            <a
              href={`https://linear.app/issue/${task.linearIssueId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan-400 hover:text-cyan-300 transition-colors text-xs font-mono"
            >
              {task.linearIssueId} ↗
            </a>
          </Row>
        </div>
      </div>
    </div>
  );
}

import { useState, useRef, useEffect } from "react";
import type { TaskWithInvocations } from "../types";
import { getStatusBadgeClasses, getStatusDisplayText } from "./ui/StatusBadge";
import { fetchTaskDetail, updateTaskStatus } from "../hooks/useApi";

const PRIORITY_LABELS: Record<number, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

const MANUAL_STATUSES = [
  { value: "backlog", label: "backlog" },
  { value: "ready", label: "queued" },
  { value: "done", label: "done" },
] as const;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

interface Props {
  task: TaskWithInvocations;
  onTaskUpdated: (task: TaskWithInvocations) => void;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-gray-500 uppercase tracking-wide">{label}</span>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export default function PropertiesPanel({ task, onTaskUpdated }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const statusMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (statusMenuRef.current && !statusMenuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const invocations = task.invocations ?? [];
  const totalCostUsd = invocations.reduce((sum, inv) => sum + (inv.costUsd ?? 0), 0);
  const totalDurationMs = invocations.reduce((sum, inv) => {
    if (!inv.endedAt) return sum;
    return sum + (new Date(inv.endedAt).getTime() - new Date(inv.startedAt).getTime());
  }, 0);
  const currentPhase = invocations.find((inv) => inv.status === "running")?.phase ?? null;

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-gray-950 border-l border-gray-800">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-800 shrink-0">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Properties</span>
      </div>

      {/* Properties */}
      <div className="flex flex-col gap-4 px-4 py-4">
        {/* Status */}
        <Row label="Status">
          <div className="relative" ref={statusMenuRef}>
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className={`text-xs px-2 py-0.5 rounded-full cursor-pointer hover:opacity-80 transition-colors ${getStatusBadgeClasses(task.orcaStatus)}`}
            >
              {getStatusDisplayText(task.orcaStatus)} &#9662;
            </button>
            {menuOpen && (
              <div className="absolute top-full left-0 mt-1 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-lg py-1 min-w-[140px]">
                {MANUAL_STATUSES.filter((s) => s.value !== task.orcaStatus).map((s) => (
                  <button
                    key={s.value}
                    onClick={() => {
                      setMenuOpen(false);
                      updateTaskStatus(task.linearIssueId, s.value)
                        .then(() => fetchTaskDetail(task.linearIssueId))
                        .then(onTaskUpdated)
                        .catch(console.error);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-700 transition-colors ${getStatusBadgeClasses(s.value)}`}
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
          <span className="text-gray-300">
            {PRIORITY_LABELS[task.priority] ?? `P${task.priority}`}
          </span>
        </Row>

        {/* Current phase */}
        {currentPhase && (
          <Row label="Phase">
            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 font-medium">
              {currentPhase}
            </span>
          </Row>
        )}

        {/* Branch */}
        {task.prBranchName && (
          <Row label="Branch">
            <span className="text-xs font-mono text-gray-300 break-all">{task.prBranchName}</span>
          </Row>
        )}

        {/* PR */}
        {task.prNumber != null && (
          <Row label="Pull Request">
            {task.prUrl ? (
              <a
                href={task.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300 underline"
              >
                #{task.prNumber}
              </a>
            ) : (
              <span className="text-gray-300">#{task.prNumber}</span>
            )}
          </Row>
        )}

        {/* Review cycles */}
        {task.reviewCycleCount > 0 && (
          <Row label="Review Cycles">
            <span className="text-gray-300 tabular-nums">{task.reviewCycleCount}</span>
          </Row>
        )}

        {/* Cost */}
        {invocations.length > 0 && (
          <Row label="Total Cost">
            <span className="text-gray-300 tabular-nums font-mono">
              ${totalCostUsd.toFixed(4)}
            </span>
          </Row>
        )}

        {/* Duration */}
        {totalDurationMs > 0 && (
          <Row label="Total Duration">
            <span className="text-gray-300 tabular-nums">{formatDuration(totalDurationMs)}</span>
          </Row>
        )}

        <div className="border-t border-gray-800 pt-4 flex flex-col gap-4">
          {/* Linear issue */}
          <Row label="Linear Issue">
            <span className="font-mono text-gray-300">{task.linearIssueId}</span>
          </Row>

          {/* Created */}
          <Row label="Created">
            <span className="text-gray-400 text-xs">{formatDate(task.createdAt)}</span>
          </Row>

          {/* Updated */}
          <Row label="Updated">
            <span className="text-gray-400 text-xs">{formatDate(task.updatedAt)}</span>
          </Row>

          {/* Done at */}
          {task.doneAt && (
            <Row label="Done At">
              <span className="text-gray-400 text-xs">{formatDate(task.doneAt)}</span>
            </Row>
          )}
        </div>
      </div>
    </div>
  );
}

import type { TaskWithInvocations } from "../types";
import { fetchTaskDetail, updateTaskStatus } from "../hooks/useApi";
import { getPriorityLabel } from "./ui/PriorityDot";
import { getStatusDisplayText } from "./ui/StatusBadge";

interface Props {
  task: TaskWithInvocations;
  open: boolean;
  onClose: () => void;
  onTaskUpdated: (task: TaskWithInvocations) => void;
}

const MANUAL_STATUSES = [
  { value: "backlog", label: "backlog", bg: "bg-gray-500/20 text-gray-500" },
  { value: "ready", label: "queued", bg: "bg-cyan-500/20 text-cyan-400" },
  { value: "done", label: "done", bg: "bg-green-500/20 text-green-400" },
] as const;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatTotalDuration(invocations: TaskWithInvocations["invocations"]): string {
  let totalMs = 0;
  for (const inv of invocations) {
    if (inv.endedAt) {
      totalMs += new Date(inv.endedAt).getTime() - new Date(inv.startedAt).getTime();
    }
  }
  if (totalMs === 0) return "—";
  const totalSecs = Math.floor(totalMs / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

interface RowProps {
  label: string;
  children: React.ReactNode;
}

function Row({ label, children }: RowProps) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-gray-800 last:border-0">
      <span className="text-xs text-gray-500 shrink-0 pt-0.5">{label}</span>
      <span className="text-xs text-gray-200 text-right">{children}</span>
    </div>
  );
}

export default function PropertiesPanel({ task, open, onClose, onTaskUpdated }: Props) {
  const invocations = task.invocations || [];
  const lastInvocation = [...invocations].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  )[0];

  const totalCost = invocations.reduce((sum, inv) => {
    return inv.costUsd != null ? sum + inv.costUsd : sum;
  }, 0);
  const hasCost = invocations.some((inv) => inv.costUsd != null);

  function handleStatusChange(newStatus: string) {
    updateTaskStatus(task.linearIssueId, newStatus)
      .then(() => fetchTaskDetail(task.linearIssueId))
      .then((updated) => onTaskUpdated(updated))
      .catch(console.error);
  }

  return (
    <div
      className={`absolute inset-y-0 right-0 w-80 bg-gray-900 border-l border-gray-800 flex flex-col transform transition-transform duration-200 z-20 ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 shrink-0">
        <span className="text-sm font-semibold text-gray-100">Properties</span>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-200 transition-colors text-lg leading-none"
          aria-label="Close properties panel"
        >
          ×
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-2">
        {/* Status row — dropdown */}
        <div className="flex items-start justify-between gap-3 py-2 border-b border-gray-800">
          <span className="text-xs text-gray-500 shrink-0 pt-1">Status</span>
          <select
            value={task.orcaStatus}
            onChange={(e) => handleStatusChange(e.target.value)}
            className="text-xs bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-gray-200 focus:outline-none focus:border-cyan-600 transition-colors cursor-pointer"
          >
            {MANUAL_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
            {/* Show current status if it's not in MANUAL_STATUSES */}
            {!MANUAL_STATUSES.find((s) => s.value === task.orcaStatus) && (
              <option value={task.orcaStatus} disabled>
                {getStatusDisplayText(task.orcaStatus)}
              </option>
            )}
          </select>
        </div>

        <Row label="Priority">{getPriorityLabel(task.priority)}</Row>
        <Row label="Phase">{lastInvocation?.phase ?? "—"}</Row>
        <Row label="PR">
          {task.prNumber != null ? (
            <a
              href={`https://github.com`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan-400 hover:text-cyan-300 transition-colors"
            >
              #{task.prNumber}
            </a>
          ) : (
            "—"
          )}
        </Row>
        <Row label="Branch">
          {task.prBranchName ? (
            <span className="font-mono text-xs">{task.prBranchName}</span>
          ) : (
            "—"
          )}
        </Row>
        <Row label="Review cycles">{task.reviewCycleCount}</Row>
        <Row label="Total cost">{hasCost ? `$${totalCost.toFixed(2)}` : "—"}</Row>
        <Row label="Total duration">{formatTotalDuration(invocations)}</Row>
        <Row label="Created">{formatDate(task.createdAt)}</Row>
        <Row label="Updated">{formatDate(task.updatedAt)}</Row>
        <Row label="Linear">{task.linearIssueId}</Row>
      </div>
    </div>
  );
}

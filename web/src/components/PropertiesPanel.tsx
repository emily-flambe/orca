import type { TaskWithInvocations } from "../types";
import { updateTaskStatus } from "../hooks/useApi";

interface Props {
  task: TaskWithInvocations;
  open: boolean;
  onClose: () => void;
  onStatusChange: (status: string) => void;
}

const MANUAL_STATUSES = [
  { value: "backlog", label: "Backlog" },
  { value: "ready", label: "Queued" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function extractGitHubPath(repoPath: string): string {
  const parts = repoPath.replace(/\\/g, "/").replace(/\/$/, "").split("/");
  if (parts.length < 2) return repoPath;
  return parts.slice(-2).join("/");
}

export default function PropertiesPanel({ task, open, onClose, onStatusChange }: Props) {
  const invocations = task.invocations || [];
  const lastInvocation = invocations.length > 0
    ? [...invocations].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0]
    : null;

  const totalCost = invocations.reduce((sum, inv) => sum + (inv.costUsd ?? 0), 0);

  const totalDurationMs = invocations.reduce((sum, inv) => {
    if (!inv.endedAt) return sum;
    return sum + (new Date(inv.endedAt).getTime() - new Date(inv.startedAt).getTime());
  }, 0);

  function formatTotalDuration(ms: number): string {
    if (ms === 0) return "—";
    const totalSecs = Math.floor(ms / 1000);
    if (totalSecs < 60) return `${totalSecs}s`;
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}m ${secs}s`;
  }

  const githubPath = task.repoPath ? extractGitHubPath(task.repoPath) : null;
  const prUrl = task.prNumber && githubPath
    ? `https://github.com/${githubPath}/pull/${task.prNumber}`
    : null;

  function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
      <div className="flex flex-col gap-0.5 py-2 border-b border-gray-800 last:border-b-0">
        <span className="text-xs text-gray-500 uppercase tracking-wide">{label}</span>
        <span className="text-sm text-gray-200">{children}</span>
      </div>
    );
  }

  return (
    <div
      className={`
        fixed top-0 right-0 h-full w-80 bg-gray-900 border-l border-gray-800 z-40
        flex flex-col shadow-xl
        transition-transform duration-200 ease-in-out
        ${open ? "translate-x-0" : "translate-x-full"}
      `}
    >
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <span className="text-sm font-medium text-gray-300">Properties</span>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-300 transition-colors text-lg leading-none"
          aria-label="Close properties panel"
        >
          ×
        </button>
      </div>

      {/* Panel body */}
      <div className="flex-1 overflow-y-auto px-4 py-2">
        {/* Status dropdown */}
        <div className="flex flex-col gap-0.5 py-2 border-b border-gray-800">
          <span className="text-xs text-gray-500 uppercase tracking-wide">Status</span>
          <select
            value={task.orcaStatus}
            onChange={(e) => {
              const newStatus = e.target.value;
              updateTaskStatus(task.linearIssueId, newStatus)
                .then(() => onStatusChange(newStatus))
                .catch(console.error);
            }}
            className="mt-0.5 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-cyan-600 transition-colors"
          >
            {MANUAL_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <Row label="Priority">{task.priority}</Row>

        <Row label="Phase">
          {lastInvocation?.phase ?? "—"}
        </Row>

        {task.prNumber != null && (
          <Row label="PR">
            {prUrl ? (
              <a
                href={prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-cyan-400 hover:text-cyan-300 transition-colors"
              >
                #{task.prNumber} ↗
              </a>
            ) : (
              `#${task.prNumber}`
            )}
          </Row>
        )}

        {task.prBranchName && (
          <Row label="Branch">
            <span className="font-mono text-xs break-all">{task.prBranchName}</span>
          </Row>
        )}

        <Row label="Review Cycles">{task.reviewCycleCount}</Row>

        <Row label="Total Cost">
          {totalCost > 0 ? `$${totalCost.toFixed(2)}` : "—"}
        </Row>

        <Row label="Total Duration">
          {formatTotalDuration(totalDurationMs)}
        </Row>

        <Row label="Created">{formatDate(task.createdAt)}</Row>
        <Row label="Updated">{formatDate(task.updatedAt)}</Row>

        {task.linearIssueId && (
          <Row label="Linear Issue">
            <a
              href={`https://linear.app/issue/${task.linearIssueId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan-400 hover:text-cyan-300 transition-colors"
            >
              {task.linearIssueId} ↗
            </a>
          </Row>
        )}
      </div>
    </div>
  );
}

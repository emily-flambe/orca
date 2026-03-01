import { useState, useEffect, useRef, Fragment } from "react";
import type { TaskWithInvocations } from "../types";
import { fetchTaskDetail, abortInvocation, retryTask, updateTaskStatus } from "../hooks/useApi";
import LogViewer from "./LogViewer";

interface Props {
  taskId: string;
}

function statusBadge(s: string): string {
  switch (s) {
    case "done": case "completed": return "bg-green-500/20 text-green-400";
    case "running": return "bg-blue-500/20 text-blue-400";
    case "ready": return "bg-cyan-500/20 text-cyan-400";
    case "failed": return "bg-red-500/20 text-red-400";
    case "dispatched": return "bg-gray-500/20 text-gray-400";
    case "timed_out": return "bg-orange-500/20 text-orange-400";
    default: return "bg-gray-500/20 text-gray-400";
  }
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "running...";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

const MANUAL_STATUSES = [
  { value: "backlog", label: "backlog", bg: "bg-gray-500/20 text-gray-500" },
  { value: "ready", label: "queued", bg: "bg-cyan-500/20 text-cyan-400" },
  { value: "done", label: "done", bg: "bg-green-500/20 text-green-400" },
] as const;

export default function TaskDetail({ taskId }: Props) {
  const [detail, setDetail] = useState<TaskWithInvocations | null>(null);
  const [selectedInvocationId, setSelectedInvocationId] = useState<number | null>(null);
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const statusMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchTaskDetail(taskId)
      .then((d) => setDetail(d))
      .catch(console.error);
  }, [taskId]);

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
    return <div className="p-4 text-gray-500">Loading...</div>;
  }

  const invocations = [...(detail.invocations || [])].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  return (
    <div className="p-4 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-mono font-semibold">{detail.linearIssueId}</h2>
        <div className="relative" ref={statusMenuRef}>
          <button
            onClick={() => setShowStatusMenu(!showStatusMenu)}
            className={`text-xs px-2 py-0.5 rounded-full cursor-pointer hover:opacity-80 transition-colors ${statusBadge(detail.orcaStatus)}`}
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
      </div>

      {/* Agent prompt (read-only, synced from Linear) */}
      <div className="space-y-2">
        <label className="text-sm text-gray-400">Agent Prompt</label>
        <pre className="w-full bg-gray-900 border border-gray-700 rounded-lg p-3 text-sm text-gray-100 whitespace-pre-wrap">
          {detail.agentPrompt || <span className="text-gray-500 italic">No prompt (issue has no description)</span>}
        </pre>
      </div>

      {/* Invocation history */}
      <div>
        <h3 className="text-sm text-gray-400 mb-2">Invocation History</h3>
        {invocations.length === 0 ? (
          <div className="text-sm text-gray-500">No invocations yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-4">Date</th>
                  <th className="pb-2 pr-4">Duration</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">Cost</th>
                  <th className="pb-2 pr-4">Turns</th>
                  <th className="pb-2 pr-4">Summary</th>
                  <th className="pb-2"></th>
                </tr>
              </thead>
              <tbody>
                {invocations.map((inv) => (
                  <Fragment key={inv.id}>
                    <tr
                      onClick={() => setSelectedInvocationId(selectedInvocationId === inv.id ? null : inv.id)}
                      className="border-b border-gray-800/50 cursor-pointer hover:bg-gray-800/50 transition-colors"
                    >
                      <td className="py-2 pr-4 text-gray-300 whitespace-nowrap">{formatDate(inv.startedAt)}</td>
                      <td className="py-2 pr-4 text-gray-300 whitespace-nowrap tabular-nums">{formatDuration(inv.startedAt, inv.endedAt)}</td>
                      <td className="py-2 pr-4">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${statusBadge(inv.status)}`}>
                          {inv.status}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-gray-300 tabular-nums">
                        {inv.costUsd != null ? `$${inv.costUsd.toFixed(2)}` : "\u2014"}
                      </td>
                      <td className="py-2 pr-4 text-gray-300 tabular-nums">{inv.numTurns ?? "\u2014"}</td>
                      <td className="py-2 pr-4 text-gray-400 truncate max-w-xs">{inv.outputSummary ?? "\u2014"}</td>
                      <td className="py-2">
                        {inv.status === "running" && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!window.confirm("Abort this invocation? The task will be reset to ready.")) return;
                              abortInvocation(inv.id)
                                .then(() => fetchTaskDetail(taskId))
                                .then((d) => setDetail(d))
                                .catch(console.error);
                            }}
                            className="text-xs px-2 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                          >
                            Abort
                          </button>
                        )}
                      </td>
                    </tr>
                    {selectedInvocationId === inv.id && (
                      <tr>
                        <td colSpan={7} className="py-2">
                          <LogViewer invocationId={inv.id} isRunning={inv.status === "running"} outputSummary={inv.outputSummary} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

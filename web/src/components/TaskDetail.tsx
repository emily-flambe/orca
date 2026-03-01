import { useState, useEffect, Fragment } from "react";
import type { TaskWithInvocations } from "../types";
import { fetchTaskDetail, abortInvocation, retryTask } from "../hooks/useApi";
import LogViewer from "./LogViewer";
import StatusMenuButton from "./StatusMenuButton";

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

export default function TaskDetail({ taskId }: Props) {
  const [detail, setDetail] = useState<TaskWithInvocations | null>(null);
  const [selectedInvocationId, setSelectedInvocationId] = useState<number | null>(null);

  useEffect(() => {
    fetchTaskDetail(taskId)
      .then((d) => setDetail(d))
      .catch(console.error);
  }, [taskId]);

  if (!detail) {
    return <div className="p-4 text-gray-500">Loading...</div>;
  }

  const invocations = [...(detail.invocations || [])].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  return (
    <div className="p-3 md:p-4 space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2 md:gap-3 flex-wrap">
        <h2 className="text-base md:text-lg font-mono font-semibold">{detail.linearIssueId}</h2>
        <StatusMenuButton
          status={detail.orcaStatus}
          taskId={detail.linearIssueId}
          onStatusChange={() => {
            fetchTaskDetail(taskId)
              .then((d) => setDetail(d))
              .catch(console.error);
          }}
        />
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
          <>
            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
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
            {/* Mobile cards */}
            <div className="md:hidden space-y-2">
              {invocations.map((inv) => (
                <Fragment key={inv.id}>
                  <div
                    onClick={() => setSelectedInvocationId(selectedInvocationId === inv.id ? null : inv.id)}
                    className="bg-gray-900 border border-gray-800 rounded-lg p-3 cursor-pointer active:bg-gray-800 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${statusBadge(inv.status)}`}>
                        {inv.status}
                      </span>
                      <span className="text-xs text-gray-500">{formatDate(inv.startedAt)}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-400">
                      <span className="tabular-nums">{formatDuration(inv.startedAt, inv.endedAt)}</span>
                      <span className="tabular-nums">{inv.costUsd != null ? `$${inv.costUsd.toFixed(2)}` : "\u2014"}</span>
                      <span className="tabular-nums">{inv.numTurns != null ? `${inv.numTurns} turns` : ""}</span>
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
                          className="ml-auto text-xs px-2 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                        >
                          Abort
                        </button>
                      )}
                    </div>
                    {inv.outputSummary && (
                      <p className="mt-2 text-xs text-gray-500 leading-relaxed">{inv.outputSummary}</p>
                    )}
                    <div className="mt-1.5 text-xs text-gray-600">
                      {selectedInvocationId === inv.id ? "Tap to hide logs \u25B4" : "Tap to view logs \u25BE"}
                    </div>
                  </div>
                  {selectedInvocationId === inv.id && (
                    <LogViewer invocationId={inv.id} isRunning={inv.status === "running"} outputSummary={inv.outputSummary} />
                  )}
                </Fragment>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import { useState, useEffect } from "react";
import type { TaskWithInvocations } from "../types";
import { fetchTaskDetail, dispatchTask } from "../hooks/useApi";

interface Props {
  taskId: string;
  linearBaseUrl: string;
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

export default function TaskDetail({ taskId, linearBaseUrl }: Props) {
  const [detail, setDetail] = useState<TaskWithInvocations | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    fetchTaskDetail(taskId)
      .then((d) => setDetail(d))
      .catch(console.error);
  }, [taskId]);

  if (!detail) {
    return <div className="p-4 text-gray-500">Loading...</div>;
  }

  const isRunning = detail.orcaStatus === "running" || detail.orcaStatus === "dispatched";

  const handleDispatch = async () => {
    setDispatching(true);
    setMessage(null);
    try {
      const result = await dispatchTask(taskId);
      setMessage({ type: "success", text: `Dispatched (invocation ${result.invocationId})` });
      // Re-fetch detail
      const d = await fetchTaskDetail(taskId);
      setDetail(d);
    } catch (err) {
      setMessage({ type: "error", text: (err as Error).message });
    } finally {
      setDispatching(false);
    }
  };

  const invocations = [...(detail.invocations || [])].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  return (
    <div className="p-4 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        {linearBaseUrl ? (
          <a
            href={`${linearBaseUrl}/issue/${detail.linearIssueId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-lg font-mono font-semibold hover:text-blue-400 hover:underline"
          >
            {detail.linearIssueId}
          </a>
        ) : (
          <h2 className="text-lg font-mono font-semibold">{detail.linearIssueId}</h2>
        )}
        <span className={`text-xs px-2 py-0.5 rounded-full ${statusBadge(detail.orcaStatus)}`}>
          {detail.orcaStatus}
        </span>
      </div>

      {/* Agent prompt (read-only, synced from Linear) */}
      <div className="space-y-2">
        <label className="text-sm text-gray-400">Agent Prompt</label>
        <pre className="w-full bg-gray-900 border border-gray-700 rounded-lg p-3 text-sm text-gray-100 whitespace-pre-wrap">
          {detail.agentPrompt || <span className="text-gray-500 italic">No prompt (issue has no description)</span>}
        </pre>
        <button
          onClick={handleDispatch}
          disabled={dispatching || isRunning}
          className="px-4 py-1.5 text-sm bg-green-600 hover:bg-green-500 disabled:opacity-50 rounded-lg transition-colors"
        >
          {dispatching ? "Dispatching..." : "Dispatch Now"}
        </button>
      </div>

      {/* Message */}
      {message && (
        <div className={`text-sm px-3 py-2 rounded ${
          message.type === "success" ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"
        }`}>
          {message.text}
        </div>
      )}

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
                  <th className="pb-2">Summary</th>
                </tr>
              </thead>
              <tbody>
                {invocations.map((inv) => (
                  <tr key={inv.id} className="border-b border-gray-800/50">
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
                    <td className="py-2 text-gray-400 truncate max-w-xs">{inv.outputSummary ?? "\u2014"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

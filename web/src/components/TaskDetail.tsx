import { useState, useEffect, useCallback } from "react";
import type { TaskWithInvocations } from "../types";
import { fetchTaskDetail, abortInvocation, retryTask } from "../hooks/useApi";
import InvocationTimeline from "./InvocationTimeline";
import PropertiesPanel from "./PropertiesPanel";
import Skeleton from "./ui/Skeleton";

interface Props {
  taskId: string;
}

// Module-level variable — persists for the browser session (cleared on page refresh)
let _panelOpen = false;

export default function TaskDetail({ taskId }: Props) {
  const [detail, setDetail] = useState<TaskWithInvocations | null>(null);
  const [panelOpen, setPanelOpen] = useState(_panelOpen);

  // Persist panel state to module-level variable
  useEffect(() => {
    _panelOpen = panelOpen;
  }, [panelOpen]);

  // Keyboard shortcut: Cmd+\ or Ctrl+\
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "\\" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPanelOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    fetchTaskDetail(taskId)
      .then((d) => setDetail(d))
      .catch(console.error);
  }, [taskId]);

  const handleAbort = useCallback(
    (invId: number) => {
      abortInvocation(invId)
        .then(() => fetchTaskDetail(taskId))
        .then((d) => setDetail(d))
        .catch(console.error);
    },
    [taskId]
  );

  const handleRetry = useCallback(() => {
    if (!detail) return;
    if (!window.confirm("Retry this task? It will be re-queued with fresh retry counters.")) return;
    retryTask(detail.linearIssueId)
      .then(() => fetchTaskDetail(taskId))
      .then((d) => setDetail(d))
      .catch(console.error);
  }, [taskId, detail]);

  if (!detail) {
    return <Skeleton lines={3} className="m-4" />;
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Main content area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-mono font-semibold">{detail.linearIssueId}</h2>

          {detail.orcaStatus === "failed" && (
            <button
              onClick={handleRetry}
              className="text-xs px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 transition-colors"
            >
              Retry
            </button>
          )}

          <span className="flex-1" />

          {/* Toggle properties panel */}
          <button
            onClick={() => setPanelOpen((prev) => !prev)}
            title="Toggle properties panel (⌘\)"
            className={`text-xs px-2 py-1 rounded transition-colors ${
              panelOpen
                ? "bg-gray-700 text-gray-200"
                : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
            }`}
          >
            ⊞ Properties
          </button>
        </div>

        {/* Agent Prompt */}
        <div className="space-y-2">
          <label className="text-sm text-gray-400">Agent Prompt</label>
          <pre className="w-full bg-gray-900 border border-gray-700 rounded-lg p-3 text-sm text-gray-100 whitespace-pre-wrap">
            {detail.agentPrompt || (
              <span className="text-gray-500 italic">No prompt (issue has no description)</span>
            )}
          </pre>
        </div>

        {/* Invocation Timeline */}
        <InvocationTimeline
          invocations={detail.invocations || []}
          taskId={taskId}
          onAbort={handleAbort}
        />
      </div>

      {/* Properties Panel */}
      <PropertiesPanel
        task={detail}
        isOpen={panelOpen}
        onToggle={() => setPanelOpen((prev) => !prev)}
        onTaskUpdate={(updated) => setDetail(updated)}
      />
    </div>
  );
}

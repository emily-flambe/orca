import { useState, useEffect, useCallback } from "react";
import type { Invocation } from "../types";
import { fetchRunningInvocations, fetchTasks } from "../hooks/useApi";
import LiveRunWidget from "./LiveRunWidget";
import { formatTokens } from "../utils/formatTokens";
import { timeAgo } from "../utils/time.js";

export interface ActiveSessionsGridProps {
  invocationStartedTrigger?: number;
  lastCompletedEvent?: {
    taskId: string;
    invocationId: number;
    status: string;
    costUsd: number;
    inputTokens?: number;
    outputTokens?: number;
  } | null;
}

export default function ActiveSessionsGrid({
  invocationStartedTrigger,
  lastCompletedEvent,
}: ActiveSessionsGridProps) {
  const [running, setRunning] = useState<Invocation[]>([]);
  const [lastCompleted, setLastCompleted] = useState<Invocation | null>(null);
  const [stalledCount, setStalledCount] = useState(0);

  const reload = useCallback(() => {
    fetchRunningInvocations().then(setRunning).catch(console.error);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Detect tasks in working states without a running invocation
  useEffect(() => {
    fetchTasks()
      .then((tasks) => {
        const workingTaskIds = new Set(
          tasks
            .filter((t) => t.lifecycleStage === "active")
            .map((t) => t.linearIssueId),
        );
        const coveredIds = new Set(running.map((inv) => inv.linearIssueId));
        let count = 0;
        for (const id of workingTaskIds) {
          if (!coveredIds.has(id)) count++;
        }
        setStalledCount(count);
      })
      .catch(() => setStalledCount(0));
  }, [running]);

  // Re-fetch running invocations when a new invocation starts
  useEffect(() => {
    if (
      invocationStartedTrigger !== undefined &&
      invocationStartedTrigger > 0
    ) {
      fetchRunningInvocations().then(setRunning).catch(console.error);
    }
  }, [invocationStartedTrigger]);

  // Handle invocation completed events from parent
  useEffect(() => {
    if (!lastCompletedEvent) return;
    const data = lastCompletedEvent;
    setRunning((prev) => {
      const completed = prev.find((inv) => inv.id === data.invocationId);
      if (completed) {
        setLastCompleted({
          ...completed,
          status: data.status as Invocation["status"],
          costUsd: data.costUsd,
          inputTokens: data.inputTokens ?? null,
          outputTokens: data.outputTokens ?? null,
          endedAt: new Date().toISOString(),
        });
      }
      return prev.filter((inv) => inv.id !== data.invocationId);
    });
  }, [lastCompletedEvent]);

  return (
    <div className="p-4">
      <h2 className="text-sm font-semibold text-gray-400 mb-3 uppercase tracking-wide">
        Active Sessions
        {running.length > 0 && (
          <span className="ml-2 text-xs px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-400 normal-case">
            {running.length}
          </span>
        )}
      </h2>

      {running.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="text-gray-500 text-sm mb-1">No active sessions</div>
          {lastCompleted ? (
            <div className="text-xs text-gray-600">
              Last completed:{" "}
              <span className="font-mono text-gray-500">
                {lastCompleted.linearIssueId}
              </span>
              {lastCompleted.endedAt && (
                <span className="ml-1">({timeAgo(lastCompleted.endedAt)})</span>
              )}
              {(lastCompleted.inputTokens != null ||
                lastCompleted.outputTokens != null) && (
                <span className="ml-1">
                  {formatTokens(
                    (lastCompleted.inputTokens ?? 0) +
                      (lastCompleted.outputTokens ?? 0),
                  )}{" "}
                  tokens
                </span>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {running.map((inv) => (
            <LiveRunWidget key={inv.id} invocation={inv} onCancelled={reload} />
          ))}
        </div>
      )}

      {stalledCount > 0 && (
        <div className="mt-3 rounded-lg border border-yellow-700/50 bg-yellow-900/10 px-4 py-2 text-xs text-yellow-400 flex items-center gap-2">
          <svg
            className="w-3.5 h-3.5 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <span>
            {stalledCount} {stalledCount === 1 ? "task" : "tasks"} in a working
            state without an active session
          </span>
        </div>
      )}
    </div>
  );
}

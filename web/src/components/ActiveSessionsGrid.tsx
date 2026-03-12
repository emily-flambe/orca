import { useState, useEffect, useCallback } from "react";
import type { Invocation } from "../types";
import { fetchRunningInvocations } from "../hooks/useApi";
import { useSSE } from "../hooks/useSSE";
import LiveRunWidget from "./LiveRunWidget";
import { formatTokens } from "../utils/formatTokens";

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

export default function ActiveSessionsGrid() {
  const [running, setRunning] = useState<Invocation[]>([]);
  const [lastCompleted, setLastCompleted] = useState<Invocation | null>(null);

  const reload = useCallback(() => {
    fetchRunningInvocations().then(setRunning).catch(console.error);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleInvocationStarted = useCallback(() => {
    // Re-fetch to get the full invocation object
    fetchRunningInvocations().then(setRunning).catch(console.error);
  }, []);

  const handleInvocationCompleted = useCallback(
    (data: {
      taskId: string;
      invocationId: number;
      status: string;
      costUsd: number;
      inputTokens?: number;
      outputTokens?: number;
    }) => {
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
    },
    [],
  );

  useSSE({
    onInvocationStarted: handleInvocationStarted,
    onInvocationCompleted: handleInvocationCompleted,
  });

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
    </div>
  );
}

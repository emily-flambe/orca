import { useState, useEffect, useCallback } from "react";
import type { Invocation } from "../types";
import { abortInvocation } from "../hooks/useApi";
import LogViewer from "./LogViewer";

interface Props {
  invocation: Invocation;
  costUsd?: number | null;  // live-updated from parent SSE; overrides invocation.costUsd
  onAborted?: () => void;
}

function formatDuration(startedAt: string, endedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const totalSecs = Math.floor((end - start) / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function borderClass(status: string): string {
  if (status === "running") return "border-cyan-500/50";
  if (status === "failed" || status === "timed_out") return "border-red-500/30";
  return "border-gray-700";
}

export default function LiveRunWidget({ invocation, costUsd: costUsdProp, onAborted }: Props) {
  // Local status tracks abort so the widget reflects cancelled state immediately,
  // without waiting for the parent to remove it.
  const [localStatus, setLocalStatus] = useState(invocation.status);
  const isRunning = localStatus === "running";

  const [duration, setDuration] = useState(() =>
    formatDuration(invocation.startedAt, invocation.endedAt)
  );
  const [aborting, setAborting] = useState(false);

  // Resolve display cost: prefer the live prop from parent SSE, fall back to invocation snapshot.
  const displayCost = costUsdProp !== undefined ? costUsdProp : invocation.costUsd;

  // Live duration timer — only runs while status is running
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => {
      setDuration(formatDuration(invocation.startedAt, null));
    }, 1000);
    return () => clearInterval(id);
  }, [isRunning, invocation.startedAt]);

  const handleAbort = useCallback(async () => {
    if (!window.confirm(`Abort invocation for ${invocation.linearIssueId}?`)) return;
    setAborting(true);
    try {
      await abortInvocation(invocation.id);
      setLocalStatus("failed");  // immediately stop pulsing dot + hide cancel button
      onAborted?.();
    } catch (err) {
      console.error("Failed to abort invocation:", err);
      setAborting(false);
    }
  }, [invocation.id, invocation.linearIssueId, onAborted]);

  return (
    <div
      className={`bg-gray-900 border rounded-lg overflow-hidden ${borderClass(localStatus)}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-gray-900 border-b border-gray-800">
        {/* Left: indicator + task ID + phase + duration */}
        <div className="flex items-center gap-2 min-w-0">
          {isRunning && (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
            </span>
          )}
          <span className="text-sm font-medium text-gray-100 shrink-0">
            {invocation.linearIssueId}
          </span>
          {invocation.phase && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-300 shrink-0">
              {invocation.phase}
            </span>
          )}
          <span className="text-xs text-gray-500 tabular-nums shrink-0">{duration}</span>
        </div>

        {/* Right: cost + abort */}
        <div className="flex items-center gap-2 shrink-0">
          {displayCost != null && (
            <span className="text-xs text-gray-400 tabular-nums">
              ${displayCost.toFixed(2)}
            </span>
          )}
          {isRunning && (
            <button
              onClick={handleAbort}
              disabled={aborting}
              title="Abort invocation"
              className="text-xs px-1.5 py-0.5 rounded text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Body: log feed — LogViewer manages its own max-height and scroll */}
      <LogViewer
        invocationId={invocation.id}
        isRunning={isRunning}
        outputSummary={invocation.outputSummary}
      />
    </div>
  );
}

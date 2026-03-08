import { useState, useEffect, useCallback } from "react";
import type { Invocation } from "../types";
import { abortInvocation } from "../hooks/useApi";
import LogViewer from "./LogViewer";

interface Props {
  invocation: Invocation;
  taskId: string;
  onCancel?: () => void;
}

function calcDuration(startedAt: string, endedAt: string | null): string {
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const ms = end - new Date(startedAt).getTime();
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

export default function LiveRunWidget({ invocation, taskId, onCancel }: Props) {
  const isRunning = invocation.status === "running" && invocation.endedAt === null;
  const [duration, setDuration] = useState(() => calcDuration(invocation.startedAt, invocation.endedAt));
  const [cost, setCost] = useState<number | null>(invocation.costUsd);

  // Update duration display every second while running
  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => {
      setDuration(calcDuration(invocation.startedAt, null));
    }, 1000);
    return () => clearInterval(interval);
  }, [isRunning, invocation.startedAt]);

  // Sync cost from prop (e.g., after parent refetches)
  useEffect(() => {
    setCost(invocation.costUsd);
  }, [invocation.costUsd]);

  const handleCostUpdate = useCallback((newCost: number) => {
    setCost(newCost);
  }, []);

  const handleCancel = () => {
    abortInvocation(invocation.id)
      .then(() => onCancel?.())
      .catch(console.error);
  };

  const costDisplay = cost != null ? `$${cost.toFixed(2)}` : "$0.00";
  const phase = invocation.phase ?? "running";
  const borderClass = isRunning ? "border-cyan-500/40" : "border-gray-700";

  return (
    <div className={`border rounded-lg overflow-hidden bg-gray-900 ${borderClass}`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-gray-800">
        <div className="flex items-center gap-2 min-w-0">
          {/* Pulsing blue dot — only when actively running */}
          {isRunning ? (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
            </span>
          ) : (
            <span className="relative inline-flex rounded-full h-2 w-2 bg-gray-600 shrink-0" />
          )}

          <span className="text-sm font-mono font-semibold text-gray-100 shrink-0">
            {taskId}
          </span>

          <span className="bg-blue-500/20 text-blue-400 text-xs px-1.5 py-0.5 rounded shrink-0">
            {phase}
          </span>

          <span className="text-xs text-gray-400 tabular-nums shrink-0">{duration}</span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-gray-400 tabular-nums">{costDisplay}</span>
          {isRunning && (
            <button
              onClick={handleCancel}
              className="text-red-400 hover:text-red-300 transition-colors text-sm leading-none"
              title="Abort invocation"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Log body */}
      <div className="max-h-64 overflow-y-auto">
        <LogViewer
          invocationId={invocation.id}
          isRunning={isRunning}
          onCostUpdate={handleCostUpdate}
        />
      </div>
    </div>
  );
}

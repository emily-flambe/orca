import { useState, useEffect, useCallback } from "react";
import type { Invocation } from "../types";
import { abortInvocation, sendInvocationPrompt } from "../hooks/useApi";
import LogViewer from "./LogViewer";

interface Props {
  invocation: Invocation;
  /** Called after a successful cancel request */
  onCancelled?: () => void;
}

function useLiveDuration(startedAt: string, endedAt: string | null): string {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (endedAt) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [endedAt]);

  const ms =
    (endedAt ? new Date(endedAt) : new Date()).getTime() -
    new Date(startedAt).getTime();
  const totalSecs = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

export default function LiveRunWidget({ invocation, onCancelled }: Props) {
  const isRunning = invocation.status === "running";
  const duration = useLiveDuration(invocation.startedAt, invocation.endedAt);

  const [cost, setCost] = useState<number | null>(invocation.costUsd);
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [promptSending, setPromptSending] = useState(false);
  const [promptFeedback, setPromptFeedback] = useState<string | null>(null);

  const handleCostUpdate = useCallback((c: number) => {
    setCost(c);
  }, []);

  const handleSendPrompt = useCallback(async () => {
    setPromptSending(true);
    try {
      await sendInvocationPrompt(invocation.id, promptText.trim());
      setPromptText("");
      setPromptFeedback("Sent");
      setTimeout(() => setPromptFeedback(null), 2000);
    } catch (err) {
      setPromptFeedback(err instanceof Error ? err.message : "Error");
    } finally {
      setPromptSending(false);
    }
  }, [invocation.id, promptText]);

  const handleCancel = useCallback(async () => {
    if (!window.confirm("Abort this invocation? The task will be reset to ready.")) return;
    setCancelling(true);
    try {
      await abortInvocation(invocation.id);
      setCancelled(true);
      onCancelled?.();
    } catch {
      // best-effort; parent will see status change via SSE
    } finally {
      setCancelling(false);
    }
  }, [invocation.id, onCancelled]);

  const effectivelyRunning = isRunning && !cancelled;
  const borderClass = effectivelyRunning
    ? "border-cyan-700"
    : "border-gray-700";

  return (
    <div className={`rounded-lg border ${borderClass} bg-gray-900 overflow-hidden`}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 bg-gray-900">
        {/* Pulsing indicator */}
        {effectivelyRunning ? (
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500" />
          </span>
        ) : (
          <span className="inline-flex rounded-full h-2.5 w-2.5 bg-gray-600 shrink-0" />
        )}

        {/* Task ID */}
        <span className="font-mono text-sm font-semibold text-gray-100">
          {invocation.linearIssueId}
        </span>

        {/* Phase badge */}
        {invocation.phase && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 font-medium">
            {invocation.phase}
          </span>
        )}

        {/* Duration */}
        <span className="text-xs text-gray-400 tabular-nums">{duration}</span>

        <span className="flex-1" />

        {/* Cost */}
        {cost != null && (
          <span className="text-xs text-gray-400 tabular-nums font-mono">
            ${cost.toFixed(2)}
          </span>
        )}

        {/* Cancel button */}
        {effectivelyRunning && (
          <button
            onClick={handleCancel}
            disabled={cancelling}
            className="text-xs px-2 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors disabled:opacity-50"
            title="Abort invocation"
          >
            {cancelling ? "…" : "✕"}
          </button>
        )}
      </div>

      {/* Log body */}
      <LogViewer
        invocationId={invocation.id}
        isRunning={effectivelyRunning}
        outputSummary={invocation.outputSummary}
        compact
        onCostUpdate={handleCostUpdate}
      />

      {effectivelyRunning && (
        <div className="border-t border-gray-800 px-3 py-2 flex items-center gap-2">
          <input
            type="text"
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (promptText.trim()) handleSendPrompt(); }}}
            placeholder="Send a message to the agent…"
            disabled={promptSending}
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-cyan-600 disabled:opacity-50"
          />
          <button
            onClick={handleSendPrompt}
            disabled={promptSending || !promptText.trim()}
            className="text-xs px-2 py-1 rounded bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 transition-colors disabled:opacity-50"
          >
            {promptSending ? "…" : "Send"}
          </button>
          {promptFeedback && (
            <span className="text-xs text-gray-400">{promptFeedback}</span>
          )}
        </div>
      )}
    </div>
  );
}

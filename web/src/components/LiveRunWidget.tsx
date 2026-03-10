import { useState, useEffect, useCallback } from "react";
import type { Invocation } from "../types";
import { abortInvocation } from "../hooks/useApi";
import LogViewer from "./LogViewer";
import { formatTokens } from "../utils/formatTokens";

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

  const totalTokens =
    invocation.inputTokens != null || invocation.outputTokens != null
      ? (invocation.inputTokens ?? 0) + (invocation.outputTokens ?? 0)
      : null;
  const [tokens, setTokens] = useState<number | null>(totalTokens);
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const promptLines = invocation.agentPrompt?.split("\n") ?? [];
  const ticketTitle = promptLines.find((l) => l.trim()) ?? null;
  const ticketDescription = ticketTitle
    ? invocation
        .agentPrompt!.slice(
          invocation.agentPrompt!.indexOf(ticketTitle) + ticketTitle.length,
        )
        .trim() || null
    : null;

  const handleTokensUpdate = useCallback((t: number) => {
    setTokens(t);
  }, []);

  const handleCancel = useCallback(async () => {
    if (
      !window.confirm("Abort this invocation? The task will be reset to ready.")
    )
      return;
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
    <div
      className={`rounded-lg border ${borderClass} bg-gray-900 overflow-hidden`}
    >
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

        {/* Tokens */}
        {tokens != null && (
          <span className="text-xs text-gray-400 tabular-nums font-mono">
            {formatTokens(tokens)}
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

      {/* Ticket title + expandable description */}
      {ticketTitle && (
        <>
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-gray-800 bg-gray-900">
            <span className="text-xs text-gray-300 truncate flex-1">
              {ticketTitle}
            </span>
            {ticketDescription && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="shrink-0 text-gray-500 hover:text-gray-300 transition-colors"
                title={expanded ? "Collapse description" : "Expand description"}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  style={{
                    transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
                    transition: "transform 0.15s",
                  }}
                >
                  <path
                    d="M3 5L7 9L11 5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
          {expanded && ticketDescription && (
            <div className="bg-gray-950 px-3 py-2 text-xs text-gray-400 font-mono whitespace-pre-wrap max-h-40 overflow-y-auto border-b border-gray-800">
              {ticketDescription}
            </div>
          )}
        </>
      )}

      {/* Log body */}
      <LogViewer
        invocationId={invocation.id}
        isRunning={effectivelyRunning}
        outputSummary={invocation.outputSummary}
        compact
        onTokensUpdate={handleTokensUpdate}
      />
    </div>
  );
}

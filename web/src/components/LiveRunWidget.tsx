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
  const [expanded, setExpanded] = useState(false);

  const promptLines = invocation.agentPrompt?.split("\n") ?? [];
  const ticketTitle = promptLines.find((l) => l.trim()) ?? null;
  const ticketDescription = ticketTitle
    ? invocation.agentPrompt!.slice(invocation.agentPrompt!.indexOf(ticketTitle) + ticketTitle.length).trim() || null
    : null;

  const [promptText, setPromptText] = useState("");
  const [promptSending, setPromptSending] = useState(false);
  const [promptFeedback, setPromptFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  const handleCostUpdate = useCallback((c: number) => {
    setCost(c);
  }, []);

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

  const handleSendPrompt = useCallback(async () => {
    const text = promptText.trim();
    if (!text) return;
    setPromptSending(true);
    setPromptFeedback(null);
    try {
      const result = await sendInvocationPrompt(invocation.id, text);
      setPromptText("");
      const message = result.status === "queued"
        ? "Message queued — will deliver after current turn"
        : "Prompt delivered";
      setPromptFeedback({ ok: true, message });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send prompt";
      setPromptFeedback({ ok: false, message });
    } finally {
      setPromptSending(false);
      // Auto-clear feedback after 4 seconds
      setTimeout(() => setPromptFeedback(null), 4000);
    }
  }, [invocation.id, promptText]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSendPrompt();
      }
    },
    [handleSendPrompt],
  );

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

      {/* Ticket title + expandable description */}
      {ticketTitle && (
        <>
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-gray-800 bg-gray-900">
            <span className="text-xs text-gray-300 truncate flex-1">{ticketTitle}</span>
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
                  style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
                >
                  <path d="M3 5L7 9L11 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
        onCostUpdate={handleCostUpdate}
      />

      {/* Prompt input — only when running */}
      {effectivelyRunning && (
        <div className="border-t border-gray-800 px-3 py-2 space-y-1.5">
          <div className="flex gap-2 items-end">
            <textarea
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Send a message to the agent… (⌘↵ to send)"
              rows={2}
              className="flex-1 resize-none bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-cyan-600 transition-colors"
            />
            <button
              onClick={handleSendPrompt}
              disabled={promptSending || !promptText.trim()}
              className="px-3 py-1.5 rounded bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            >
              {promptSending ? "…" : "Send"}
            </button>
          </div>
          {promptFeedback && (
            <p className={`text-xs ${promptFeedback.ok ? "text-cyan-400" : "text-red-400"}`}>
              {promptFeedback.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

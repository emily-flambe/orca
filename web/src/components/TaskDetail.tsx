import { useState, useEffect, useRef, Fragment } from "react";
import type { TaskWithInvocations } from "../types";
import {
  fetchTaskDetail,
  fetchTaskTransitions,
  abortInvocation,
  retryTask,
  updateTaskStatus,
  type TaskStateTransition,
} from "../hooks/useApi";
import LogViewer from "./LogViewer";
import LiveRunWidget from "./LiveRunWidget";
import { getStatusBadgeClasses } from "./ui/StatusBadge";
import StatusBadge from "./ui/StatusBadge";
import Skeleton from "./ui/Skeleton";
import EmptyState from "./ui/EmptyState";
import { formatTokens } from "../utils/formatTokens";
import { MANUAL_STATUSES } from "../constants.js";
import { timeAgo } from "../utils/time.js";
import {
  PR_STATE_COLORS,
  PR_ICON_PATH,
  PR_MERGE_ICON_PATH,
} from "./pr-utils.js";

interface Props {
  taskId: string;
  initialInvocationId?: number;
  refreshTrigger?: number;
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

export default function TaskDetail({
  taskId,
  initialInvocationId,
  refreshTrigger,
}: Props) {
  const [detail, setDetail] = useState<TaskWithInvocations | null>(null);
  const [selectedInvocationId, setSelectedInvocationId] = useState<
    number | null
  >(null);
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [transitions, setTransitions] = useState<TaskStateTransition[]>([]);
  const statusMenuRef = useRef<HTMLDivElement>(null);
  const statusTriggerRef = useRef<HTMLButtonElement>(null);

  // Focus first menu item when the status menu opens
  useEffect(() => {
    if (!showStatusMenu || !statusMenuRef.current) return;
    const first =
      statusMenuRef.current.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, [showStatusMenu]);

  useEffect(() => {
    fetchTaskDetail(taskId)
      .then((d) => {
        setDetail(d);
        setLastUpdated(new Date());
      })
      .catch(console.error);
    fetchTaskTransitions(taskId)
      .then(setTransitions)
      .catch(() => setTransitions([]));
  }, [taskId, refreshTrigger]);

  useEffect(() => {
    if (detail && initialInvocationId != null) {
      setSelectedInvocationId(initialInvocationId);
    }
  }, [detail, initialInvocationId]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        statusMenuRef.current &&
        !statusMenuRef.current.contains(e.target as Node)
      ) {
        setShowStatusMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  if (!detail) {
    return <Skeleton lines={3} className="m-4" />;
  }

  const invocations = [...(detail.invocations || [])].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );

  const runningInvocation = invocations.find((inv) => inv.status === "running");

  return (
    <div className="p-4 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-mono font-semibold">
          {detail.linearIssueId}
        </h2>
        <div className="relative" ref={statusMenuRef}>
          <button
            ref={statusTriggerRef}
            aria-haspopup="menu"
            aria-expanded={showStatusMenu}
            aria-label={`Change status: ${detail.orcaStatus}`}
            onClick={() => setShowStatusMenu(!showStatusMenu)}
            className={`text-xs px-2 py-0.5 rounded-full cursor-pointer hover:opacity-80 transition-colors ${getStatusBadgeClasses(detail.orcaStatus)}`}
          >
            {detail.orcaStatus === "ready" ? "queued" : detail.orcaStatus}{" "}
            &#9662;
          </button>
          {showStatusMenu && (
            <div
              role="menu"
              className="absolute top-full left-0 mt-1 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-lg py-1 min-w-[120px]"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setShowStatusMenu(false);
                  statusTriggerRef.current?.focus();
                  return;
                }
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const items = Array.from(
                    e.currentTarget.querySelectorAll<HTMLElement>(
                      '[role="menuitem"]',
                    ),
                  );
                  const idx = items.indexOf(
                    document.activeElement as HTMLElement,
                  );
                  if (e.key === "ArrowDown") {
                    items[idx === -1 ? 0 : (idx + 1) % items.length]?.focus();
                  } else {
                    items[
                      idx === -1
                        ? items.length - 1
                        : (idx - 1 + items.length) % items.length
                    ]?.focus();
                  }
                }
              }}
            >
              {MANUAL_STATUSES.filter((s) => s.value !== detail.orcaStatus).map(
                (s) => (
                  <button
                    key={s.value}
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() => {
                      setShowStatusMenu(false);
                      updateTaskStatus(detail.linearIssueId, s.value)
                        .then(() => fetchTaskDetail(taskId))
                        .then((d) => setDetail(d))
                        .catch(console.error);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-700 transition-colors ${s.bg}`}
                  >
                    {s.label}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
        {detail.orcaStatus === "failed" && (
          <button
            onClick={() => {
              if (
                !window.confirm(
                  "Retry this task? It will be re-queued with fresh retry counters.",
                )
              )
                return;
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
        {lastUpdated && (
          <span className="ml-auto text-xs text-gray-600">
            Updated {timeAgo(lastUpdated)}
          </span>
        )}
      </div>

      {/* Live run widget — shown when task has an active invocation */}
      {runningInvocation && (
        <LiveRunWidget
          invocation={runningInvocation}
          onCancelled={() =>
            fetchTaskDetail(taskId)
              .then((d) => setDetail(d))
              .catch(console.error)
          }
        />
      )}

      {/* PR info */}
      {detail.prUrl && detail.prState && (
        <div className="space-y-2">
          <h3 className="text-sm text-gray-400">Pull Request</h3>
          <div className="flex items-center gap-2">
            <svg
              viewBox="0 0 16 16"
              width={16}
              height={16}
              fill={PR_STATE_COLORS[detail.prState] ?? PR_STATE_COLORS.open}
              aria-hidden="true"
            >
              <path
                d={
                  detail.prState === "merged"
                    ? PR_MERGE_ICON_PATH
                    : PR_ICON_PATH
                }
              />
            </svg>
            <a
              href={detail.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-400 hover:text-blue-300 underline"
              aria-label={`Pull request${detail.prNumber ? ` #${detail.prNumber}` : ""} — ${detail.prState}`}
            >
              {detail.prNumber ? `#${detail.prNumber}` : detail.prUrl}
            </a>
            <span
              className="text-xs px-1.5 py-0.5 rounded-full capitalize"
              style={{
                color: PR_STATE_COLORS[detail.prState] ?? PR_STATE_COLORS.open,
                backgroundColor: `${PR_STATE_COLORS[detail.prState] ?? PR_STATE_COLORS.open}20`,
              }}
            >
              {detail.prState}
            </span>
            {detail.prBranchName && (
              <code className="text-xs text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">
                {detail.prBranchName}
              </code>
            )}
          </div>
        </div>
      )}

      {/* Agent prompt (read-only, synced from Linear) */}
      <div className="space-y-2">
        <label className="text-sm text-gray-400">Agent Prompt</label>
        <pre className="w-full bg-gray-900 border border-gray-700 rounded-lg p-3 text-sm text-gray-100 whitespace-pre-wrap">
          {detail.agentPrompt || (
            <span className="text-gray-500 italic">
              No prompt (issue has no description)
            </span>
          )}
        </pre>
      </div>

      {/* Invocation history */}
      <div>
        <h3 className="text-sm text-gray-400 mb-2">Invocation History</h3>
        {invocations.length === 0 ? (
          <EmptyState message="No invocations yet" />
        ) : (
          <>
            {/* Mobile: card layout */}
            <div className="md:hidden space-y-2">
              {invocations.map((inv) => (
                <div
                  key={inv.id}
                  className="border border-gray-800 rounded-lg overflow-hidden"
                >
                  <button
                    onClick={() =>
                      setSelectedInvocationId(
                        selectedInvocationId === inv.id ? null : inv.id,
                      )
                    }
                    className="w-full text-left px-3 py-2.5 hover:bg-gray-800/50 active:bg-gray-800 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-xs text-gray-400">
                        {formatDate(inv.startedAt)}
                      </span>
                      <StatusBadge status={inv.status} className="shrink-0" />
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-400">
                      <span className="tabular-nums">
                        {formatDuration(inv.startedAt, inv.endedAt)}
                      </span>
                      {(inv.inputTokens != null ||
                        inv.outputTokens != null) && (
                        <span className="tabular-nums">
                          {formatTokens(
                            (inv.inputTokens ?? 0) + (inv.outputTokens ?? 0),
                          )}{" "}
                          tokens
                          <span className="text-gray-500 ml-1">
                            ({formatTokens(inv.inputTokens ?? 0)}↑{" "}
                            {formatTokens(inv.outputTokens ?? 0)}↓)
                          </span>
                        </span>
                      )}
                      {inv.numTurns != null && (
                        <span className="tabular-nums">
                          {inv.numTurns} turns
                        </span>
                      )}
                    </div>
                    {inv.outputSummary && (
                      <p className="text-xs text-gray-500 mt-1 line-clamp-2">
                        {inv.outputSummary}
                      </p>
                    )}
                  </button>
                  {inv.status === "running" && (
                    <div className="px-3 pb-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (
                            !window.confirm(
                              "Abort this invocation? The task will be reset to ready.",
                            )
                          )
                            return;
                          abortInvocation(inv.id)
                            .then(() => fetchTaskDetail(taskId))
                            .then((d) => setDetail(d))
                            .catch(console.error);
                        }}
                        className="text-xs px-2 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                      >
                        Abort
                      </button>
                    </div>
                  )}
                  {selectedInvocationId === inv.id && (
                    <div className="border-t border-gray-800">
                      <LogViewer
                        invocationId={inv.id}
                        isRunning={inv.status === "running"}
                        outputSummary={inv.outputSummary}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Desktop: table layout */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-800">
                    <th className="pb-2 pr-4">Date</th>
                    <th className="pb-2 pr-4">Duration</th>
                    <th className="pb-2 pr-4">Status</th>
                    <th className="pb-2 pr-4">Tokens</th>
                    <th className="pb-2 pr-4">Turns</th>
                    <th className="pb-2 pr-4">Rate</th>
                    <th className="pb-2 pr-4">Summary</th>
                    <th className="pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {invocations.map((inv) => (
                    <Fragment key={inv.id}>
                      <tr
                        onClick={() =>
                          setSelectedInvocationId(
                            selectedInvocationId === inv.id ? null : inv.id,
                          )
                        }
                        className="border-b border-gray-800/50 cursor-pointer hover:bg-gray-800/50 transition-colors"
                      >
                        <td className="py-2 pr-4 text-gray-300 whitespace-nowrap">
                          {formatDate(inv.startedAt)}
                        </td>
                        <td className="py-2 pr-4 text-gray-300 whitespace-nowrap tabular-nums">
                          {formatDuration(inv.startedAt, inv.endedAt)}
                        </td>
                        <td className="py-2 pr-4">
                          <StatusBadge status={inv.status} />
                        </td>
                        <td className="py-2 pr-4 text-gray-300 tabular-nums">
                          {inv.inputTokens != null ||
                          inv.outputTokens != null ? (
                            <span
                              title={`in: ${formatTokens(inv.inputTokens ?? 0)} / out: ${formatTokens(inv.outputTokens ?? 0)}`}
                            >
                              {formatTokens(
                                (inv.inputTokens ?? 0) +
                                  (inv.outputTokens ?? 0),
                              )}
                              <span className="text-gray-500 text-xs ml-1">
                                ({formatTokens(inv.inputTokens ?? 0)}↑{" "}
                                {formatTokens(inv.outputTokens ?? 0)}↓)
                              </span>
                            </span>
                          ) : (
                            "\u2014"
                          )}
                        </td>
                        <td className="py-2 pr-4 text-gray-300 tabular-nums">
                          {inv.numTurns ?? "\u2014"}
                        </td>
                        <td className="py-2 pr-4 text-gray-400 tabular-nums text-xs">
                          {(() => {
                            if (inv.costUsd == null || !inv.endedAt)
                              return "\u2014";
                            const ms =
                              new Date(inv.endedAt).getTime() -
                              new Date(inv.startedAt).getTime();
                            const hours = ms / 3_600_000;
                            if (hours < 0.001) return "\u2014";
                            const rate = inv.costUsd / hours;
                            return `$${rate.toFixed(2)}/hr`;
                          })()}
                        </td>
                        <td className="py-2 pr-4 text-gray-400 truncate max-w-xs">
                          {inv.outputSummary ?? "\u2014"}
                        </td>
                        <td className="py-2">
                          {inv.status === "running" && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (
                                  !window.confirm(
                                    "Abort this invocation? The task will be reset to ready.",
                                  )
                                )
                                  return;
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
                          <td colSpan={8} className="py-2">
                            <LogViewer
                              invocationId={inv.id}
                              isRunning={inv.status === "running"}
                              outputSummary={inv.outputSummary}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* State Transitions */}
      {transitions.length > 0 && (
        <div>
          <h3 className="text-sm text-gray-400 mb-2">State Transitions</h3>
          <div className="space-y-1">
            {[...transitions].reverse().map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-3 text-xs py-1.5 border-b border-gray-800/50"
              >
                <span className="text-gray-500 whitespace-nowrap">
                  {formatDate(t.createdAt)}
                </span>
                <span className="text-gray-400">
                  {t.fromStatus ?? "—"} → {t.toStatus}
                </span>
                {t.reason && <span className="text-gray-600">{t.reason}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

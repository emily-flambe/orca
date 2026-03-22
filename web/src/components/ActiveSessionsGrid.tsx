import type { Invocation } from "../types";
import LiveRunWidget from "./LiveRunWidget";
import { formatTokens } from "../utils/formatTokens";
import { timeAgo } from "../utils/time.js";

interface ActiveSessionsGridProps {
  running: Invocation[];
  lastCompleted: Invocation | null;
  onCancelled?: () => void;
}

export default function ActiveSessionsGrid({
  running,
  lastCompleted,
  onCancelled,
}: ActiveSessionsGridProps) {
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
            <LiveRunWidget key={inv.id} invocation={inv} onCancelled={onCancelled} />
          ))}
        </div>
      )}
    </div>
  );
}

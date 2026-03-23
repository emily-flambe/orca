import { useState, useEffect, useCallback } from "react";
import { fetchSystemEvents } from "../hooks/useApi";
import type { SystemEvent } from "../hooks/useApi";

type FilterType = "all" | "deploy" | "startup" | "error";

function statusBadge(metadata: Record<string, unknown> | null) {
  const s = metadata?.status as string | undefined;
  if (!s) return null;
  const cls =
    s === "success"
      ? "bg-green-900/60 text-green-300 border-green-700"
      : s === "failure"
        ? "bg-red-900/60 text-red-300 border-red-700"
        : s === "start"
          ? "bg-blue-900/60 text-blue-300 border-blue-700"
          : "bg-gray-800 text-gray-400 border-gray-700";
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded border ${cls}`}>{s}</span>
  );
}

function EventRow({ event }: { event: SystemEvent }) {
  const [expanded, setExpanded] = useState(false);
  const meta = event.metadata as Record<string, unknown> | null;

  const date = new Date(event.createdAt);
  const timeStr = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const dateStr = date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });

  const typeColor =
    event.type === "deploy"
      ? "text-purple-400"
      : event.type === "error"
        ? "text-red-400"
        : event.type === "startup"
          ? "text-blue-400"
          : "text-gray-400";

  return (
    <div className="border-b border-gray-800 last:border-0">
      <button
        className="w-full text-left px-4 py-2.5 hover:bg-gray-800/40 transition-colors flex items-start gap-3"
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Timestamp */}
        <span className="shrink-0 text-xs text-gray-500 tabular-nums pt-0.5 w-32">
          <span className="text-gray-600">{dateStr} </span>
          {timeStr}
        </span>

        {/* Type badge */}
        <span className={`shrink-0 text-xs font-mono pt-0.5 w-16 ${typeColor}`}>
          {event.type}
        </span>

        {/* Status badge (for deploy events) */}
        {meta && statusBadge(meta)}

        {/* Message */}
        <span className="flex-1 text-sm text-gray-300 break-words">
          {event.message}
        </span>

        {meta && (
          <span className="shrink-0 text-xs text-gray-600 pt-0.5">
            {expanded ? "▲" : "▼"}
          </span>
        )}
      </button>

      {expanded && meta && (
        <div className="px-4 pb-3 ml-48">
          <div className="bg-gray-900 border border-gray-700 rounded p-3 text-xs font-mono text-gray-300 space-y-1">
            {Object.entries(meta).map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <span className="text-gray-500 w-32 shrink-0">{k}</span>
                <span className="break-all">{String(v)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function LogsPage() {
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterType>("all");
  const [limit, setLimit] = useState(100);

  const load = useCallback(() => {
    setLoading(true);
    fetchSystemEvents({ limit, type: filter === "all" ? undefined : filter })
      .then((data) => {
        setEvents(data);
        setError(null);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoading(false));
  }, [limit, filter]);

  useEffect(() => {
    load();
  }, [load]);

  const deployEvents = events.filter((e) => e.type === "deploy");
  const lastDeploy = deployEvents.find((e) => {
    const m = e.metadata as Record<string, unknown> | null;
    return m?.status === "success";
  });

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
        System Events
      </h2>

      {/* Summary card — last deploy */}
      {lastDeploy &&
        (() => {
          const m =
            (lastDeploy.metadata as Record<string, unknown> | null) ?? {};
          return (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm space-y-1">
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">
                Last Successful Deploy
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-gray-300">
                <span>
                  <span className="text-gray-500">commit </span>
                  {String(m.commitSha ?? "—").slice(0, 8)}
                </span>
                <span>
                  <span className="text-gray-500">port </span>
                  {String(m.oldPort ?? "—")} → {String(m.newPort ?? "—")}
                </span>
                {m.orphanedSessions !== undefined && (
                  <span>
                    <span className="text-gray-500">orphaned sessions </span>
                    {String(m.orphanedSessions)}
                  </span>
                )}
                <span className="text-gray-500">
                  {new Date(lastDeploy.createdAt).toLocaleString()}
                </span>
              </div>
            </div>
          );
        })()}

      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex rounded overflow-hidden border border-gray-700">
          {(["all", "deploy", "startup", "error"] as FilterType[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs transition-colors ${
                filter === f
                  ? "bg-gray-700 text-gray-100"
                  : "bg-gray-900 text-gray-400 hover:text-gray-200"
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300 cursor-pointer"
        >
          <option value={50}>Last 50</option>
          <option value={100}>Last 100</option>
          <option value={250}>Last 250</option>
          <option value={500}>Last 500</option>
        </select>

        <button
          onClick={load}
          className="text-xs px-2 py-1.5 rounded bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
        >
          Refresh
        </button>

        <span className="text-xs text-gray-600 ml-auto">
          {events.length} event{events.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Event list */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-4 text-sm text-gray-500">Loading...</div>
        ) : error ? (
          <div className="p-4 text-sm text-red-400">Error: {error}</div>
        ) : events.length === 0 ? (
          <div className="p-4 text-sm text-gray-500">No events recorded.</div>
        ) : (
          events.map((e) => <EventRow key={e.id} event={e} />)
        )}
      </div>
    </div>
  );
}

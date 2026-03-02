import { useState, useEffect, useRef, useCallback } from "react";
import { fetchSystemLogs } from "../hooks/useApi";

export default function SystemLog() {
  const [lines, setLines] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [sizeBytes, setSizeBytes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [tail, setTail] = useState(200);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const load = useCallback(() => {
    fetchSystemLogs({ tail, filter: filter || undefined })
      .then((data) => {
        setLines(data.lines);
        setTotal(data.total);
        setSizeBytes(data.sizeBytes);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [tail, filter]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // Auto-refresh
  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(load, 5000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [autoRefresh, load]);

  // Scroll to bottom when lines change during auto-refresh
  useEffect(() => {
    if (autoRefresh && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [lines, autoRefresh]);

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <div className="p-4 space-y-3 h-full flex flex-col">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap shrink-0">
        <h2 className="text-sm font-semibold text-gray-300">System Log</h2>

        <input
          type="text"
          placeholder="Filter..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 min-w-32 max-w-64 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-gray-500"
        />

        <select
          value={tail}
          onChange={(e) => setTail(Number(e.target.value))}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 cursor-pointer"
        >
          <option value={100}>Last 100</option>
          <option value={200}>Last 200</option>
          <option value={500}>Last 500</option>
          <option value={1000}>Last 1000</option>
          <option value={5000}>Last 5000</option>
        </select>

        <button
          onClick={() => setAutoRefresh((v) => !v)}
          className={`text-xs px-2 py-1 rounded transition-colors ${
            autoRefresh
              ? "bg-blue-600 text-blue-100 hover:bg-blue-700"
              : "bg-gray-800 text-gray-400 hover:text-gray-200"
          }`}
        >
          {autoRefresh ? "Auto-refresh on" : "Auto-refresh"}
        </button>

        <button
          onClick={() => { setLoading(true); load(); }}
          className="text-xs px-2 py-1 rounded bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
        >
          Refresh
        </button>

        <span className="text-xs text-gray-600 ml-auto">
          {filter ? `${lines.length} / ${total} lines` : `${total} lines`}
          {sizeBytes > 0 && ` · ${formatSize(sizeBytes)}`}
        </span>
      </div>

      {/* Log content */}
      <div className="flex-1 overflow-y-auto bg-gray-900 border border-gray-800 rounded-lg min-h-0">
        {loading ? (
          <div className="p-4 text-sm text-gray-500">Loading...</div>
        ) : error ? (
          <div className="p-4 text-sm text-red-400">Error: {error}</div>
        ) : lines.length === 0 ? (
          <div className="p-4 text-sm text-gray-500">
            {filter ? "No lines match the filter." : "Log file is empty or does not exist yet."}
          </div>
        ) : (
          <div className="p-3 font-mono text-xs text-gray-300 space-y-0.5">
            {lines.map((line, i) => (
              <LogLine key={i} line={line} filter={filter} />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </div>
  );
}

// Highlight filter match in a line
function LogLine({ line, filter }: { line: string; filter: string }) {
  const isError = /\berror\b|\bfailed\b|\bException\b|\bstack trace\b/i.test(line);
  const isWarn = /\bwarn\b|\bwarning\b/i.test(line);

  const baseColor = isError
    ? "text-red-400"
    : isWarn
    ? "text-yellow-400"
    : "text-gray-300";

  if (!filter) {
    return <div className={`whitespace-pre-wrap break-all leading-5 ${baseColor}`}>{line}</div>;
  }

  // Split line on filter match for highlighting
  const lowerLine = line.toLowerCase();
  const lowerFilter = filter.toLowerCase();
  const parts: { text: string; highlight: boolean }[] = [];
  let idx = 0;
  let match: number;
  while ((match = lowerLine.indexOf(lowerFilter, idx)) !== -1) {
    if (match > idx) parts.push({ text: line.slice(idx, match), highlight: false });
    parts.push({ text: line.slice(match, match + filter.length), highlight: true });
    idx = match + filter.length;
  }
  if (idx < line.length) parts.push({ text: line.slice(idx), highlight: false });

  return (
    <div className={`whitespace-pre-wrap break-all leading-5 ${baseColor}`}>
      {parts.map((p, i) =>
        p.highlight ? (
          <mark key={i} className="bg-yellow-500/30 text-yellow-200 rounded-sm">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </div>
  );
}

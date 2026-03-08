import { useState, useEffect, useRef, useCallback } from "react";
import { fetchInvocationLogs } from "../hooks/useApi";

interface Props {
  invocationId: number;
  isRunning?: boolean;
  outputSummary?: string | null;
}

// ---------------------------------------------------------------------------
// ndjson message shape (subset of Claude stream-json)
// ---------------------------------------------------------------------------

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  // tool_result fields
  tool_use_id?: string;
  content?: ContentBlock[] | string;
  is_error?: boolean;
}

interface Message {
  content?: ContentBlock[];
}

interface LogLine {
  type?: string;
  subtype?: string;
  message?: Message;
  // result fields
  total_cost_usd?: number;
  cost_usd?: number;
  num_turns?: number;
  result?: string;
  // stderr / process_exit fields (added by orca runner)
  timestamp?: string;
  text?: string;
  code?: number | null;
  signal?: string | null;
  // rate_limit_event fields
  overageStatus?: string;
  rateLimitType?: string;
  resetsAt?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format an ISO timestamp as HH:MM:SS for compact display. */
function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-US", { hour12: false });
  } catch {
    return iso;
  }
}

/** Extract plain text from a tool_result content field (string or block array). */
function extractToolResultText(content: ContentBlock[] | string | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Timestamp({ iso }: { iso: string }) {
  return (
    <span className="text-gray-600 text-xs font-mono mr-2 select-none">
      {formatTimestamp(iso)}
    </span>
  );
}

/** Assistant text block — green */
function TextBlock({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap text-sm text-green-400 leading-relaxed font-mono">
      {text}
    </pre>
  );
}

/** Tool call block — cyan with bold name, collapsed input */
function ToolUseBlock({ name, input }: { name: string; input: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-gray-800 text-cyan-400 hover:text-cyan-200 transition-colors font-mono"
      >
        <span className="font-bold">{name}</span>
        <span className="text-gray-500">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <pre className="mt-1 ml-2 p-2 text-xs bg-gray-800 rounded text-cyan-300/70 whitespace-pre-wrap max-h-60 overflow-y-auto font-mono">
          {typeof input === "string" ? input : JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** Tool result block — dimmer cyan, collapsed */
function ToolResultBlock({
  content,
  isError,
}: {
  content: string;
  isError?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const colorClass = isError
    ? "text-red-400 hover:text-red-200"
    : "text-cyan-300/70 hover:text-cyan-200";
  const contentColor = isError ? "text-red-400" : "text-cyan-300/70";
  return (
    <div className="my-1">
      <button
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-gray-800 transition-colors font-mono ${colorClass}`}
      >
        <span>↳ result</span>
        <span className="text-gray-500">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <pre
          className={`mt-1 ml-2 p-2 text-xs bg-gray-800 rounded whitespace-pre-wrap max-h-60 overflow-y-auto font-mono ${contentColor}`}
        >
          {content || "(empty)"}
        </pre>
      )}
    </div>
  );
}

/** Thinking block — purple, collapsed by default */
function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs text-purple-400 hover:text-purple-200 transition-colors font-mono"
      >
        {open ? "▼" : "▶"} <span className="italic">Thinking...</span>
      </button>
      {open && (
        <pre className="mt-1 ml-2 p-2 text-xs bg-gray-800/50 rounded text-purple-400/70 whitespace-pre-wrap max-h-40 overflow-y-auto font-mono">
          {text}
        </pre>
      )}
    </div>
  );
}

/** Stderr line — red */
function StderrLine({ line }: { line: LogLine }) {
  return (
    <div className="font-mono text-xs">
      {line.timestamp && <Timestamp iso={line.timestamp} />}
      <span className="text-red-400">{line.text ?? ""}</span>
    </div>
  );
}

/** Process exit / system / rate-limit — yellow */
function SystemLine({
  label,
  detail,
  timestamp,
}: {
  label: string;
  detail?: string;
  timestamp?: string;
}) {
  return (
    <div className="font-mono text-xs text-yellow-400">
      {timestamp && <Timestamp iso={timestamp} />}
      <span>{label}</span>
      {detail && <span className="text-yellow-400/60 ml-2">{detail}</span>}
    </div>
  );
}

function ResultFooter({ line }: { line: LogLine }) {
  const cost = line.total_cost_usd ?? line.cost_usd;
  return (
    <div className="mt-3 pt-2 border-t border-gray-700 text-xs text-gray-500 flex gap-4 font-mono">
      <span>Result: {line.subtype ?? "unknown"}</span>
      {cost != null && <span>Cost: ${cost.toFixed(2)}</span>}
      {line.num_turns != null && <span>Turns: {line.num_turns}</span>}
      {typeof line.result === "string" && line.result.length > 0 && (
        <span className="truncate max-w-md" title={line.result}>
          {line.result.slice(0, 120)}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function LogViewer({ invocationId, isRunning, outputSummary }: Props) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true); // true = auto-scroll to bottom

  // Auto-scroll logic: scroll to bottom when pinned and new lines arrive
  const scrollToBottom = useCallback(() => {
    if (containerRef.current && pinnedRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, []);

  // Track user scroll to disengage/re-engage pin
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distanceFromBottom < 50;
  }, []);

  // Scroll to bottom when lines change (if pinned)
  useEffect(() => {
    scrollToBottom();
  }, [lines, scrollToBottom]);

  useEffect(() => {
    let cancelled = false;

    if (isRunning) {
      // SSE streaming mode
      const es = new EventSource(`/api/invocations/${invocationId}/logs/stream`);

      es.addEventListener("log", (e) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(e.data) as LogLine;
          setLines((prev) => [...prev, parsed]);
          setLoading(false);
          setError(null);
        } catch {
          // ignore parse errors
        }
      });

      es.addEventListener("done", () => {
        // Set cancelled before closing so the "error" event that browsers
        // sometimes fire after a server-initiated close is ignored.
        cancelled = true;
        setLoading(false);
        es.close();
      });

      es.addEventListener("error", () => {
        if (cancelled) return;
        // SSE error — connection dropped. Fall back to polling endpoint once.
        cancelled = true;
        es.close();
        fetchInvocationLogs(invocationId)
          .then((data) => {
            if (cancelled) return;
            setLines(data.lines as LogLine[]);
            setLoading(false);
          })
          .catch((err) => {
            if (cancelled) return;
            setError(err instanceof Error ? err.message : String(err));
            setLoading(false);
          });
      });

      // Initial loading state — hide spinner once first log line arrives
      // (handled by the "log" listener above setting loading=false)
      // Set a short timeout so we don't show spinner forever if no lines arrive yet
      const loadingTimeout = setTimeout(() => {
        if (!cancelled) setLoading(false);
      }, 2000);

      return () => {
        cancelled = true;
        clearTimeout(loadingTimeout);
        es.close();
      };
    } else {
      // Polling / completed mode — fetch once
      fetchInvocationLogs(invocationId)
        .then((data) => {
          if (cancelled) return;
          setLines(data.lines as LogLine[]);
          setLoading(false);
          setError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });

      return () => {
        cancelled = true;
      };
    }
  }, [invocationId, isRunning]);

  if (loading) {
    return (
      <div className="p-4 text-sm text-gray-500">Loading logs...</div>
    );
  }

  if (error) {
    if (outputSummary) {
      return (
        <div className="p-4 bg-gray-900 border border-gray-800 rounded-lg">
          <div className="text-xs text-gray-500 mb-2">No log file (agent never started)</div>
          <pre className="whitespace-pre-wrap text-sm text-red-400 leading-relaxed font-mono">
            {outputSummary}
          </pre>
        </div>
      );
    }
    return (
      <div className="p-4 text-sm text-red-400">Error: {error}</div>
    );
  }

  if (lines.length === 0) {
    if (outputSummary) {
      return (
        <div className="p-4 bg-gray-900 border border-gray-800 rounded-lg">
          <div className="text-xs text-gray-500 mb-2">No log file (agent never started)</div>
          <pre className="whitespace-pre-wrap text-sm text-red-400 leading-relaxed font-mono">
            {outputSummary}
          </pre>
        </div>
      );
    }
    return (
      <div className="p-4 text-sm text-gray-500">No log entries</div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="max-h-[32rem] overflow-y-auto p-4 bg-gray-900 border border-gray-800 rounded-lg space-y-3"
    >
      {lines.map((line, idx) => {
        // stderr — red
        if (line.type === "stderr") {
          return <StderrLine key={idx} line={line} />;
        }

        // process_exit — yellow
        if (line.type === "process_exit") {
          const detail =
            line.signal
              ? `signal ${line.signal}`
              : line.code != null
              ? `exit code ${line.code}`
              : undefined;
          return (
            <SystemLine
              key={idx}
              label="Process exited"
              detail={detail}
              timestamp={line.timestamp}
            />
          );
        }

        // rate_limit_event — yellow warning
        if (line.type === "rate_limit_event") {
          const detail = line.resetsAt ? `resets at ${line.resetsAt}` : undefined;
          return (
            <SystemLine
              key={idx}
              label={`Rate limited: ${line.rateLimitType ?? "unknown"}`}
              detail={detail}
            />
          );
        }

        // system — yellow (e.g. init)
        if (line.type === "system") {
          const detail = line.subtype ? `(${line.subtype})` : undefined;
          return <SystemLine key={idx} label="System" detail={detail} />;
        }

        // Result footer
        if (line.type === "result") {
          return <ResultFooter key={idx} line={line} />;
        }

        // Assistant messages — text: green, tool_use: cyan, thinking: purple
        if (line.type === "assistant" && line.message?.content) {
          const blocks = line.message.content;
          const hasContent = blocks.some(
            (b) =>
              (b.type === "text" && b.text) ||
              b.type === "tool_use" ||
              (b.type === "thinking" && b.thinking)
          );
          if (!hasContent) return null;

          return (
            <div key={idx} className="space-y-1">
              {blocks.map((block, bi) => {
                if (block.type === "text" && block.text) {
                  return <TextBlock key={bi} text={block.text} />;
                }
                if (block.type === "tool_use" && block.name) {
                  return (
                    <ToolUseBlock
                      key={bi}
                      name={block.name}
                      input={block.input}
                    />
                  );
                }
                if (block.type === "thinking" && block.thinking) {
                  return <ThinkingBlock key={bi} text={block.thinking} />;
                }
                return null;
              })}
            </div>
          );
        }

        // User messages — render tool_result blocks in dimmer cyan
        if (line.type === "user" && line.message?.content) {
          const toolResults = line.message.content.filter(
            (b) => b.type === "tool_result"
          );
          if (toolResults.length === 0) return null;

          return (
            <div key={idx} className="space-y-1">
              {toolResults.map((block, bi) => {
                const text = extractToolResultText(block.content);
                return (
                  <ToolResultBlock
                    key={bi}
                    content={text}
                    isError={block.is_error}
                  />
                );
              })}
            </div>
          );
        }

        // Unknown / unhandled types — skip silently
        return null;
      })}
      {isRunning && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
          </span>
          Session running...
        </div>
      )}
    </div>
  );
}

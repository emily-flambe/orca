import { useState, useEffect, useRef, useCallback } from "react";
import { fetchInvocationLogs } from "../hooks/useApi";

interface Props {
  invocationId: number;
  isRunning?: boolean;
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
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TextBlock({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap text-sm text-gray-200 leading-relaxed">
      {text}
    </pre>
  );
}

function ToolUseBlock({ name, input }: { name: string; input: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
      >
        <span className="font-mono">{name}</span>
        <span>{open ? "\u25B4" : "\u25BE"}</span>
      </button>
      {open && (
        <pre className="mt-1 ml-2 p-2 text-xs bg-gray-800 rounded text-gray-400 overflow-x-auto max-h-60 overflow-y-auto">
          {typeof input === "string" ? input : JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
      >
        {open ? "\u25BC" : "\u25B6"} Thinking...
      </button>
      {open && (
        <pre className="mt-1 ml-2 p-2 text-xs bg-gray-800/50 rounded text-gray-500 whitespace-pre-wrap max-h-40 overflow-y-auto">
          {text}
        </pre>
      )}
    </div>
  );
}

function ResultFooter({ line }: { line: LogLine }) {
  const cost = line.total_cost_usd ?? line.cost_usd;
  return (
    <div className="mt-3 pt-2 border-t border-gray-700 text-xs text-gray-500 flex gap-4">
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

export default function LogViewer({ invocationId, isRunning }: Props) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [stickToBottom, setStickToBottom] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevLineCountRef = useRef(0);

  // -- Completed/failed: fetch all lines at once --
  useEffect(() => {
    if (isRunning) return;

    fetchInvocationLogs(invocationId)
      .then((data) => {
        setLines(data.lines as LogLine[]);
        setLoading(false);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [invocationId, isRunning]);

  // -- Running: connect to SSE stream --
  useEffect(() => {
    if (!isRunning) return;

    setLoading(true);
    setStreaming(true);
    setLines([]);

    const es = new EventSource(`/api/invocations/${invocationId}/logs`);

    es.addEventListener("log", (e) => {
      try {
        const parsed = JSON.parse(e.data) as LogLine;
        setLines((prev) => [...prev, parsed]);
        setLoading(false);
      } catch {
        // skip malformed lines
      }
    });

    es.addEventListener("done", () => {
      setStreaming(false);
      es.close();
    });

    es.addEventListener("error", () => {
      // EventSource auto-reconnects, but if the invocation ended
      // the endpoint will return JSON (not SSE), causing permanent errors.
      // Close and fall back to a one-time fetch.
      es.close();
      setStreaming(false);
      fetchInvocationLogs(invocationId)
        .then((data) => {
          setLines(data.lines as LogLine[]);
          setLoading(false);
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });
    });

    // First log event means we're loaded
    const onFirstMessage = () => {
      setLoading(false);
      es.removeEventListener("log", onFirstMessage);
    };
    es.addEventListener("log", onFirstMessage);

    return () => {
      es.close();
      setStreaming(false);
    };
  }, [invocationId, isRunning]);

  // Auto-scroll when new lines arrive (if stickToBottom is on)
  useEffect(() => {
    if (
      stickToBottom &&
      lines.length > prevLineCountRef.current &&
      containerRef.current
    ) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
    prevLineCountRef.current = lines.length;
  }, [lines, stickToBottom]);

  // Detect manual scroll to disable stick-to-bottom
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setStickToBottom(atBottom);
  }, []);

  if (loading && lines.length === 0) {
    return (
      <div className="p-4 text-sm text-gray-500">Loading logs...</div>
    );
  }

  if (error && lines.length === 0) {
    return (
      <div className="p-4 text-sm text-red-400">Error: {error}</div>
    );
  }

  if (!loading && lines.length === 0) {
    return (
      <div className="p-4 text-sm text-gray-500">No log entries</div>
    );
  }

  return (
    <div className="relative">
      {/* Stick-to-bottom toggle (only while streaming) */}
      {streaming && (
        <div className="absolute top-2 right-2 z-10">
          <button
            onClick={() => {
              setStickToBottom(!stickToBottom);
              if (!stickToBottom && containerRef.current) {
                containerRef.current.scrollTop = containerRef.current.scrollHeight;
              }
            }}
            className={`text-xs px-2 py-1 rounded transition-colors ${
              stickToBottom
                ? "bg-gray-700 text-gray-300"
                : "bg-gray-800 text-gray-500 hover:text-gray-300"
            }`}
            title={stickToBottom ? "Auto-scroll on" : "Auto-scroll off"}
          >
            {stickToBottom ? "\u2193 Following" : "\u2193 Follow"}
          </button>
        </div>
      )}

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="max-h-[32rem] overflow-y-auto p-4 bg-gray-900 border border-gray-800 rounded-lg space-y-3"
      >
        {lines.map((line, idx) => {
          // Skip system messages
          if (line.type === "system") return null;

          // Result footer
          if (line.type === "result") {
            return <ResultFooter key={idx} line={line} />;
          }

          // Assistant messages
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

          // Skip other message types
          return null;
        })}
        {streaming && (
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
            Streaming...
          </div>
        )}
      </div>
    </div>
  );
}

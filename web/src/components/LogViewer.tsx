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
  content?: string | ContentBlock[];
  tool_use_id?: string;
}

interface Message {
  content?: ContentBlock[];
}

interface LogLine {
  type?: string;
  subtype?: string;
  message?: Message;
  timestamp?: string;
  error?: string;
  // result fields
  total_cost_usd?: number;
  cost_usd?: number;
  num_turns?: number;
  result?: string;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Timestamp({ value }: { value: string }) {
  return (
    <span className="font-mono text-xs text-gray-600 mr-2 select-none">
      {value}
    </span>
  );
}

function TextBlock({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap text-sm text-green-400 leading-relaxed font-mono">
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
        className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-gray-700 text-cyan-400 hover:text-cyan-200 transition-colors font-mono"
      >
        <span className="font-bold">{name}</span>
        <span>{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <pre className="mt-1 ml-2 p-2 text-xs bg-gray-800 rounded text-gray-400 overflow-x-auto max-h-60 overflow-y-auto font-mono">
          {typeof input === "string" ? input : JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ToolResultBlock({ content }: { content: string | ContentBlock[] | undefined }) {
  const [open, setOpen] = useState(false);

  const displayText =
    typeof content === "string"
      ? content
      : Array.isArray(content)
      ? content
          .map((b) => (typeof b === "string" ? b : b.text ?? ""))
          .join("\n")
      : "";

  return (
    <div className="my-1">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-gray-700/50 text-cyan-300/70 hover:text-cyan-300 transition-colors font-mono"
      >
        <span>tool result</span>
        <span>{open ? "\u25B4" : "\u25BE"}</span>
      </button>
      {open && (
        <pre className="mt-1 ml-2 p-2 text-xs bg-gray-800/50 rounded text-cyan-300/70 whitespace-pre-wrap max-h-60 overflow-y-auto font-mono">
          {displayText}
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
        className="text-xs text-purple-400 hover:text-purple-300 transition-colors font-mono"
      >
        {open ? "▼" : "▶"} Thinking...
      </button>
      {open && (
        <pre className="mt-1 ml-2 p-2 text-xs bg-gray-800/50 rounded text-purple-300/70 whitespace-pre-wrap max-h-40 overflow-y-auto font-mono">
          {text}
        </pre>
      )}
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
      className="max-h-[32rem] overflow-y-auto p-4 bg-gray-900 border border-gray-800 rounded-lg space-y-3 font-mono"
    >
      {lines.map((line, idx) => {
        // Error lines
        if (line.type === "error") {
          return (
            <div key={idx} className="text-sm text-red-400 font-mono">
              {line.timestamp && <Timestamp value={line.timestamp} />}
              <span>{line.error ?? "Unknown error"}</span>
            </div>
          );
        }

        // System messages — only render if there's meaningful text content
        if (line.type === "system") {
          const content = line.message?.content;
          const hasText =
            Array.isArray(content) &&
            content.some((b) => b.type === "text" && b.text && b.text.trim().length > 0);
          if (!hasText) return null;

          const textContent = Array.isArray(content)
            ? content
                .filter((b) => b.type === "text" && b.text)
                .map((b) => b.text)
                .join("\n")
            : "";

          return (
            <div key={idx} className="text-xs text-yellow-400 font-mono">
              {line.timestamp && <Timestamp value={line.timestamp} />}
              <span className="mr-1 opacity-60">[system]</span>
              <span>{textContent}</span>
            </div>
          );
        }

        // Result footer
        if (line.type === "result") {
          return <ResultFooter key={idx} line={line} />;
        }

        // Tool result lines — Claude stream-json wraps tool results in type:"user"
        if (line.type === "user" && line.message?.content) {
          const toolResultBlocks = line.message.content.filter(
            (b) => b.type === "tool_result"
          );
          if (toolResultBlocks.length === 0) return null;
          return (
            <div key={idx} className="space-y-1">
              {line.timestamp && <Timestamp value={line.timestamp} />}
              {toolResultBlocks.map((block, bi) => (
                <ToolResultBlock key={bi} content={block.content} />
              ))}
            </div>
          );
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
              {line.timestamp && <Timestamp value={line.timestamp} />}
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

        // Info / stdout — plain string lines or unrecognized types with text
        if (line.type === "info" || line.type === "stdout") {
          return (
            <div key={idx} className="text-sm text-gray-400 font-mono">
              {line.timestamp && <Timestamp value={line.timestamp} />}
              <span>{(line as unknown as Record<string, string>).text ?? String(line)}</span>
            </div>
          );
        }

        // Skip other message types (tool_progress, stream_event, etc.)
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

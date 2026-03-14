import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
} from "react";
import { fetchInvocationLogs } from "../hooks/useApi";
import { formatTokens } from "../utils/formatTokens";

interface Props {
  invocationId: number;
  isRunning?: boolean;
  outputSummary?: string | null;
  compact?: boolean;
  onCostUpdate?: (cost: number) => void;
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
  // for tool_result
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
}

interface Message {
  content?: ContentBlock[];
}

interface LogLine {
  type?: string;
  subtype?: string;
  message?: Message;
  timestamp?: string;
  text?: string; // stderr
  code?: number | null; // process_exit
  signal?: string | null; // process_exit
  codeDescription?: string | null; // process_exit
  // result fields
  total_cost_usd?: number;
  cost_usd?: number;
  num_turns?: number;
  result?: string;
  usage?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Timestamp({ iso }: { iso: string }) {
  try {
    const t = new Date(iso);
    const hh = t.getHours().toString().padStart(2, "0");
    const mm = t.getMinutes().toString().padStart(2, "0");
    const ss = t.getSeconds().toString().padStart(2, "0");
    return (
      <span className="mr-2 text-xs text-gray-600 font-mono select-none">
        {hh}:{mm}:{ss}
      </span>
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TextBlock({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap text-sm text-green-400 font-mono leading-relaxed">
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
        className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-cyan-900/30 text-cyan-400 hover:text-cyan-300 transition-colors"
      >
        <span className="font-mono font-bold">{name}</span>
        <span className="text-cyan-600">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <pre className="mt-1 ml-2 p-2 text-xs bg-gray-800 rounded text-cyan-300/70 font-mono whitespace-pre-wrap max-h-60 overflow-y-auto">
          {typeof input === "string" ? input : JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ToolResultBlock({
  content,
}: {
  content: string | Array<{ type: string; text?: string }>;
}) {
  const [open, setOpen] = useState(false);

  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text ?? "")
      .join("\n");
  }

  if (!text) return null;

  return (
    <div className="my-1">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-cyan-900/20 text-cyan-300/70 hover:text-cyan-300 transition-colors"
      >
        <span className="font-mono">↩ result</span>
        <span>{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <pre className="mt-1 ml-2 p-2 text-xs bg-gray-800 rounded text-cyan-300/70 font-mono whitespace-pre-wrap max-h-60 overflow-y-auto">
          {text}
        </pre>
      )}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="my-1">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs text-purple-400 hover:text-purple-300 transition-colors font-mono"
      >
        {open ? "▼" : "▶"} Thinking…
      </button>
      {open && (
        <pre className="mt-1 ml-2 p-2 text-xs bg-purple-900/10 rounded text-purple-400/70 font-mono whitespace-pre-wrap max-h-40 overflow-y-auto">
          {text}
        </pre>
      )}
    </div>
  );
}

function SystemLine({ line }: { line: LogLine }) {
  // Skip noisy init messages
  if (line.subtype === "init") return null;
  const label = line.subtype ? `[system:${line.subtype}]` : "[system]";
  return (
    <div className="text-xs text-yellow-400 font-mono">
      {line.timestamp && <Timestamp iso={line.timestamp} />}
      {label}
    </div>
  );
}

function StderrLine({ line }: { line: LogLine }) {
  if (!line.text) return null;
  return (
    <pre className="whitespace-pre-wrap text-xs text-red-400 font-mono leading-relaxed">
      {line.timestamp && <Timestamp iso={line.timestamp} />}
      {line.text}
    </pre>
  );
}

function StdoutLine({ line }: { line: LogLine }) {
  if (!line.text) return null;
  return (
    <pre className="whitespace-pre-wrap text-xs text-gray-400 font-mono leading-relaxed">
      {line.timestamp && <Timestamp iso={line.timestamp} />}
      {line.text}
    </pre>
  );
}

function ProcessExitLine({ line }: { line: LogLine }) {
  const normal = line.code === 0 && !line.signal;
  const colorClass = normal ? "text-gray-500" : "text-yellow-400";
  const desc = line.signal
    ? `signal ${line.signal}`
    : `exit ${line.code ?? "?"}${line.codeDescription ? ` (${line.codeDescription})` : ""}`;
  return (
    <div className={`text-xs font-mono ${colorClass}`}>
      {line.timestamp && <Timestamp iso={line.timestamp} />}
      [process] {desc}
    </div>
  );
}

function ResultFooter({ line }: { line: LogLine }) {
  const usage = line.usage as Record<string, number> | undefined;
  const inputTokens = usage
    ? (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0)
    : null;
  const outputTokens = usage ? (usage.output_tokens ?? 0) : null;
  const totalTokens =
    inputTokens != null && outputTokens != null
      ? inputTokens + outputTokens
      : null;
  return (
    <div className="mt-3 pt-2 border-t border-gray-700 text-xs text-gray-500 font-mono flex gap-4">
      {line.timestamp && <Timestamp iso={line.timestamp} />}
      <span>Result: {line.subtype ?? "unknown"}</span>
      {totalTokens != null && <span>Tokens: {formatTokens(totalTokens)}</span>}
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

export default function LogViewer({
  invocationId,
  isRunning,
  outputSummary,
  compact,
  onCostUpdate,
}: Props) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);
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
    setShowJump(distanceFromBottom >= 50);
  }, []);

  // Jump to bottom button handler: re-engage pin and scroll
  const handleJumpToBottom = useCallback(() => {
    pinnedRef.current = true;
    setShowJump(false);
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Scroll to bottom when lines change (if pinned).
  // useLayoutEffect runs before paint so completed invocations start at bottom
  // without users ever seeing the top.
  useLayoutEffect(() => {
    scrollToBottom();
  }, [lines, scrollToBottom]);

  useEffect(() => {
    let cancelled = false; // true = component unmounted, don't update state

    if (isRunning) {
      // SSE streaming mode
      const es = new EventSource(
        `/api/invocations/${invocationId}/logs/stream`,
      );

      let sseDone = false; // true = SSE stream closed (done or error handled)
      let receivedAnyLines = false;

      es.addEventListener("log", (e) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(e.data) as LogLine;
          receivedAnyLines = true;
          setLines((prev) => [...prev, parsed]);
          setLoading(false);
          setError(null);
          const cost = parsed.total_cost_usd ?? parsed.cost_usd;
          if (cost != null && onCostUpdate) onCostUpdate(cost);
        } catch {
          // ignore parse errors
        }
      });

      es.addEventListener("done", () => {
        sseDone = true;
        es.close();
        // If no log lines arrived, the server had no in-memory state (e.g.,
        // after a deploy restart). Fall back to the polling endpoint so we
        // still show whatever is on disk.
        if (!receivedAnyLines) {
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
        } else {
          setLoading(false);
        }
      });

      es.addEventListener("error", () => {
        if (sseDone || cancelled) return;
        // SSE error — connection dropped. Fall back to polling endpoint once.
        sseDone = true;
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
      <div className="p-4 text-sm text-gray-500 font-mono">Loading logs...</div>
    );
  }

  if (error) {
    if (outputSummary) {
      return (
        <div className="p-4 bg-gray-900 border border-gray-800 rounded-lg">
          <div className="text-xs text-gray-500 mb-2 font-mono">
            No log file (agent never started)
          </div>
          <pre className="whitespace-pre-wrap text-sm text-red-400 font-mono leading-relaxed">
            {outputSummary}
          </pre>
        </div>
      );
    }
    return (
      <div className="p-4 text-sm text-red-400 font-mono">Error: {error}</div>
    );
  }

  if (lines.length === 0) {
    if (outputSummary) {
      return (
        <div className="p-4 bg-gray-900 border border-gray-800 rounded-lg">
          <div className="text-xs text-gray-500 mb-2 font-mono">
            No log file (agent never started)
          </div>
          <pre className="whitespace-pre-wrap text-sm text-red-400 font-mono leading-relaxed">
            {outputSummary}
          </pre>
        </div>
      );
    }
    return (
      <div className="p-4 text-sm text-gray-500 font-mono">No log entries</div>
    );
  }

  return (
    <div className="relative">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className={`overflow-y-auto overflow-x-hidden p-4 bg-gray-900 border border-gray-800 rounded-lg space-y-3 font-mono ${compact ? "max-h-64" : "max-h-[32rem]"}`}
      >
        {lines.map((line, idx) => {
          const type = line.type;

          // System messages — show non-init ones as yellow, skip init
          if (type === "system") {
            return <SystemLine key={idx} line={line} />;
          }

          // Stderr output — red
          if (type === "stderr") {
            return <StderrLine key={idx} line={line} />;
          }

          // Stdout / info — gray
          if (type === "stdout" || type === "info") {
            return <StdoutLine key={idx} line={line} />;
          }

          // Process exit — gray (normal) or yellow (abnormal)
          if (type === "process_exit") {
            return <ProcessExitLine key={idx} line={line} />;
          }

          // Result footer
          if (type === "result") {
            return <ResultFooter key={idx} line={line} />;
          }

          // Assistant messages — green text, cyan tool calls, purple thinking
          if (type === "assistant" && line.message?.content) {
            const blocks = line.message.content;
            const hasContent = blocks.some(
              (b) =>
                (b.type === "text" && b.text) ||
                b.type === "tool_use" ||
                (b.type === "thinking" && b.thinking),
            );
            if (!hasContent) return null;

            return (
              <div key={idx} className="space-y-1">
                {line.timestamp && (
                  <div className="text-xs text-gray-600 font-mono select-none">
                    <Timestamp iso={line.timestamp} />
                  </div>
                )}
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

          // User messages — render tool_result blocks in cyan-dimmer
          if (type === "user" && line.message?.content) {
            const blocks = line.message.content;
            const resultBlocks = blocks.filter(
              (b) => b.type === "tool_result" && b.content != null,
            );
            if (resultBlocks.length === 0) return null;

            return (
              <div key={idx} className="space-y-1">
                {line.timestamp && (
                  <div className="text-xs text-gray-600 font-mono select-none">
                    <Timestamp iso={line.timestamp} />
                  </div>
                )}
                {resultBlocks.map((block, bi) => {
                  return (
                    <ToolResultBlock
                      key={bi}
                      content={
                        block.content as
                          | string
                          | Array<{ type: string; text?: string }>
                      }
                    />
                  );
                })}
              </div>
            );
          }

          // Skip other message types
          return null;
        })}
        {isRunning && (
          <div className="flex items-center gap-2 text-xs text-gray-500 font-mono">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
            </span>
            Session running...
          </div>
        )}
      </div>
      {showJump && (
        <button
          onClick={handleJumpToBottom}
          className="absolute bottom-4 right-4 flex items-center gap-1 px-3 py-1.5 text-xs font-mono bg-gray-800 border border-gray-600 text-gray-300 rounded-full shadow-lg hover:bg-gray-700 hover:text-white transition-colors"
        >
          ↓ Jump to bottom
        </button>
      )}
    </div>
  );
}

import { useState, useEffect, useRef, useCallback } from "react";
import { fetchInvocationLogs } from "../hooks/useApi";

interface Props {
  invocationId: number;
  status: string;
}

// ---------------------------------------------------------------------------
// Log line type definitions (matches ndjson output from Claude CLI)
// ---------------------------------------------------------------------------

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
}

interface LogLine {
  type: string;
  subtype?: string;
  content?: ContentBlock[];
  // result fields
  total_cost_usd?: number;
  cost_usd?: number;
  num_turns?: number;
  result?: string;
  // system fields
  session_id?: string;
  tools?: unknown[];
  model?: string;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderContentBlock(block: ContentBlock, index: number) {
  if (block.type === "text" && block.text) {
    return (
      <div key={index} className="whitespace-pre-wrap text-gray-200 text-sm leading-relaxed">
        {block.text}
      </div>
    );
  }

  if (block.type === "tool_use" && block.name) {
    return (
      <ToolUseBlock key={index} name={block.name} input={block.input} />
    );
  }

  if (block.type === "thinking" && block.thinking) {
    return (
      <ThinkingBlock key={index} text={block.thinking} />
    );
  }

  return null;
}

function ToolUseBlock({ name, input }: { name: string; input: unknown }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-1 border border-gray-700 rounded bg-gray-900/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-gray-800/50"
      >
        <span className="text-gray-500 text-xs">{expanded ? "\u25BC" : "\u25B6"}</span>
        <span className="text-cyan-400 font-mono text-xs">{name}</span>
      </button>
      {expanded && input != null && (
        <pre className="px-3 py-2 text-xs text-gray-400 overflow-x-auto border-t border-gray-700 max-h-60 overflow-y-auto">
          {typeof input === "string" ? input : JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-1 border border-gray-700/50 rounded bg-gray-900/30">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-gray-800/30"
      >
        <span className="text-gray-500 text-xs">{expanded ? "\u25BC" : "\u25B6"}</span>
        <span className="text-gray-500 text-xs italic">thinking</span>
      </button>
      {expanded && (
        <pre className="px-3 py-2 text-xs text-gray-500 whitespace-pre-wrap border-t border-gray-700/50 max-h-60 overflow-y-auto">
          {text}
        </pre>
      )}
    </div>
  );
}

function ResultFooter({ line }: { line: LogLine }) {
  const cost = line.total_cost_usd ?? line.cost_usd;
  const turns = line.num_turns;
  const summary = line.result;

  return (
    <div className="mt-3 border-t border-gray-700 pt-3 text-sm">
      <div className="flex items-center gap-4 text-gray-400">
        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-300">result</span>
        {cost != null && <span>Cost: ${cost.toFixed(4)}</span>}
        {turns != null && <span>Turns: {turns}</span>}
      </div>
      {summary && (
        <div className="mt-2 text-gray-300 whitespace-pre-wrap">{summary}</div>
      )}
    </div>
  );
}

function renderLogLine(line: LogLine, index: number) {
  // Skip system messages.
  if (line.type === "system") return null;

  // Result message — show as summary footer.
  if (line.type === "result") {
    return <ResultFooter key={index} line={line} />;
  }

  // Assistant message — render content blocks.
  if (line.type === "assistant" && Array.isArray(line.content)) {
    const blocks = line.content
      .map((block, i) => renderContentBlock(block, i))
      .filter(Boolean);
    if (blocks.length === 0) return null;
    return (
      <div key={index} className="py-1">
        {blocks}
      </div>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function LogViewer({ invocationId, status }: Props) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  // Track streaming state internally so it updates when the SSE stream ends,
  // even if the parent prop stays "running" due to stale data.
  const [streamActive, setStreamActive] = useState(status === "running");
  const containerRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when new lines arrive (if stickToBottom is enabled).
  const scrollToBottom = useCallback(() => {
    if (stickToBottom && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [stickToBottom]);

  useEffect(() => {
    scrollToBottom();
  }, [lines, scrollToBottom]);

  // Detect user scrolling away from bottom to disable auto-scroll.
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 40;
    setStickToBottom(atBottom);
  }, []);

  useEffect(() => {
    setLines([]);
    setLoading(true);
    setError(null);
    const isRunning = status === "running";
    setStreamActive(isRunning);

    if (!isRunning) {
      // Completed invocation — fetch full log as JSON array.
      fetchInvocationLogs(invocationId)
        .then((data) => {
          setLines(data.lines as LogLine[]);
          setLoading(false);
        })
        .catch((err) => {
          setError(err.message);
          setLoading(false);
        });
      return;
    }

    // Running invocation — connect to SSE endpoint.
    const es = new EventSource(`/api/invocations/${invocationId}/logs`);
    let closed = false;

    es.addEventListener("log", (e) => {
      try {
        const line = JSON.parse(e.data) as LogLine;
        setLines((prev) => [...prev, line]);
      } catch {
        // skip unparseable lines
      }
    });

    es.addEventListener("done", () => {
      setStreamActive(false);
      setLoading(false);
      closed = true;
      es.close();
    });

    es.addEventListener("open", () => {
      setLoading(false);
    });

    es.onerror = () => {
      if (closed) return;
      closed = true;
      es.close();
      // SSE failed — fall back to JSON fetch (invocation may have completed
      // between the time the parent rendered and the SSE request arrived).
      fetchInvocationLogs(invocationId)
        .then((data) => {
          setLines(data.lines as LogLine[]);
          setStreamActive(false);
          setLoading(false);
        })
        .catch((err) => {
          setError(err.message);
          setStreamActive(false);
          setLoading(false);
        });
    };

    return () => {
      closed = true;
      es.close();
    };
  }, [invocationId, status]);

  return (
    <div className="border border-gray-700 rounded-lg bg-gray-950 mt-2">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 text-xs">
        <div className="flex items-center gap-2">
          {streamActive ? (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
          ) : (
            <span className="inline-flex rounded-full h-2 w-2 bg-gray-500" />
          )}
          <span className="text-gray-400">
            {streamActive ? "Streaming" : "Completed"} — {lines.length} messages
          </span>
        </div>
        {streamActive && (
          <button
            onClick={() => {
              setStickToBottom(!stickToBottom);
              if (!stickToBottom) scrollToBottom();
            }}
            className={`px-2 py-0.5 rounded text-xs ${
              stickToBottom
                ? "bg-blue-500/20 text-blue-400"
                : "bg-gray-700 text-gray-400"
            }`}
          >
            Auto-scroll {stickToBottom ? "on" : "off"}
          </button>
        )}
      </div>

      {/* Log content */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="p-3 overflow-y-auto max-h-[500px] space-y-1"
      >
        {loading && lines.length === 0 && (
          <div className="text-gray-500 text-sm">Loading logs...</div>
        )}
        {error && (
          <div className="text-red-400 text-sm">Error: {error}</div>
        )}
        {lines.map((line, i) => renderLogLine(line, i))}
      </div>
    </div>
  );
}

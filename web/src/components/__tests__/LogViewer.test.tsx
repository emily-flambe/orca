import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import LogViewer from "../LogViewer";
import { fetchInvocationLogs } from "../../hooks/useApi";

vi.mock("../../hooks/useApi", () => ({
  fetchInvocationLogs: vi.fn(),
}));

const mockFetchInvocationLogs = vi.mocked(fetchInvocationLogs);

// ---------------------------------------------------------------------------
// MockEventSource
// ---------------------------------------------------------------------------

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  private listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (e: MessageEvent) => void) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(cb);
  }

  emit(type: string, data?: string) {
    const event = data ? ({ data } as MessageEvent) : ({} as MessageEvent);
    (this.listeners[type] ?? []).forEach((cb) => cb(event));
  }

  close() {
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  MockEventSource.instances = [];
  global.EventSource = MockEventSource as unknown as typeof EventSource;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ndjsonResponse(lines: unknown[]) {
  return Promise.resolve({ lines });
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

describe("LogViewer states", () => {
  it("shows loading state while fetch is pending", () => {
    mockFetchInvocationLogs.mockReturnValue(new Promise(() => {}));
    render(<LogViewer invocationId={1} />);
    expect(screen.getByText("Loading logs...")).toBeInTheDocument();
  });

  it("shows error message without outputSummary", async () => {
    mockFetchInvocationLogs.mockRejectedValue(new Error("fetch failed"));
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("Error: fetch failed")).toBeInTheDocument();
    });
  });

  it("shows no-log-file fallback with outputSummary on error", async () => {
    mockFetchInvocationLogs.mockRejectedValue(new Error("not found"));
    render(<LogViewer invocationId={1} outputSummary="Agent crashed early" />);
    await waitFor(() => {
      expect(
        screen.getByText("No log file (agent never started)"),
      ).toBeInTheDocument();
      expect(screen.getByText("Agent crashed early")).toBeInTheDocument();
    });
  });

  it("shows 'No log entries' when lines are empty and no outputSummary", async () => {
    mockFetchInvocationLogs.mockResolvedValue({ lines: [] });
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("No log entries")).toBeInTheDocument();
    });
  });

  it("shows no-log-file fallback with outputSummary when lines are empty", async () => {
    mockFetchInvocationLogs.mockResolvedValue({ lines: [] });
    render(
      <LogViewer invocationId={1} outputSummary="Session summary text" />,
    );
    await waitFor(() => {
      expect(
        screen.getByText("No log file (agent never started)"),
      ).toBeInTheDocument();
      expect(screen.getByText("Session summary text")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Log line rendering (polling mode)
// ---------------------------------------------------------------------------

describe("LogViewer log line rendering", () => {
  it("renders assistant text block", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Hello world" }],
          },
        },
      ]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("Hello world")).toBeInTheDocument();
    });
  });

  it("renders assistant tool_use block as button; expands JSON on click", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Read",
                input: { file_path: "/foo.ts" },
              },
            ],
          },
        },
      ]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("Read")).toBeInTheDocument();
    });

    // Input should be collapsed initially
    expect(screen.queryByText(/"file_path"/)).not.toBeInTheDocument();

    // Click to expand
    fireEvent.click(screen.getByText("Read"));
    await waitFor(() => {
      expect(screen.getByText(/"file_path"/)).toBeInTheDocument();
    });
  });

  it("renders assistant thinking block; initially open; click collapses", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([
        {
          type: "assistant",
          message: {
            content: [{ type: "thinking", thinking: "Let me think..." }],
          },
        },
      ]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText(/Thinking…/)).toBeInTheDocument();
    });

    // Initially open — thinking text visible
    expect(screen.getByText("Let me think...")).toBeInTheDocument();

    // Click to collapse
    fireEvent.click(screen.getByText(/Thinking…/));
    expect(screen.queryByText("Let me think...")).not.toBeInTheDocument();
  });

  it("renders user tool_result block as button; expands on click", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "x",
                content: "file contents here",
              },
            ],
          },
        },
      ]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("↩ result")).toBeInTheDocument();
    });

    // Content collapsed initially
    expect(screen.queryByText("file contents here")).not.toBeInTheDocument();

    // Click to expand
    fireEvent.click(screen.getByText("↩ result"));
    await waitFor(() => {
      expect(screen.getByText("file contents here")).toBeInTheDocument();
    });
  });

  it("renders nothing for user message with no tool_result", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([
        {
          type: "user",
          message: {
            content: [{ type: "text", text: "some user text" }],
          },
        },
      ]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.queryByText("some user text")).not.toBeInTheDocument();
    });
  });

  it("renders stderr line", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([{ type: "stderr", text: "error text" }]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("error text")).toBeInTheDocument();
    });
  });

  it("renders stdout line", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([{ type: "stdout", text: "some output" }]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("some output")).toBeInTheDocument();
    });
  });

  it("renders info line", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([{ type: "info", text: "info output" }]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("info output")).toBeInTheDocument();
    });
  });

  it("skips system init subtype", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([{ type: "system", subtype: "init" }]),
    );
    render(<LogViewer invocationId={1} />);
    // Wait for loading to finish — no system init content expected
    await waitFor(() => {
      expect(screen.queryByText(/\[system/)).not.toBeInTheDocument();
    });
  });

  it("renders system non-init subtype as [system:start]", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([{ type: "system", subtype: "start" }]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("[system:start]")).toBeInTheDocument();
    });
  });

  it("renders process_exit with code 0", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([{ type: "process_exit", code: 0, signal: null }]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText(/exit 0/)).toBeInTheDocument();
    });
  });

  it("renders process_exit with code 1", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([{ type: "process_exit", code: 1, signal: null }]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText(/exit 1/)).toBeInTheDocument();
    });
  });

  it("renders process_exit with signal SIGTERM", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([
        { type: "process_exit", code: null, signal: "SIGTERM" },
      ]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText(/signal SIGTERM/)).toBeInTheDocument();
    });
  });

  it("renders result footer with usage", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([
        {
          type: "result",
          subtype: "success",
          num_turns: 5,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      ]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("Result: success")).toBeInTheDocument();
      expect(screen.getByText("Tokens: 150")).toBeInTheDocument();
      expect(screen.getByText("Turns: 5")).toBeInTheDocument();
    });
  });

  it("renders result footer with result text", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([
        {
          type: "result",
          subtype: "error_max_turns",
          result: "session timed out",
        },
      ]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("Result: error_max_turns")).toBeInTheDocument();
      expect(screen.getByText("session timed out")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// isRunning behavior
// ---------------------------------------------------------------------------

describe("LogViewer isRunning", () => {
  it("shows 'Session running...' when isRunning=true", async () => {
    // Never resolves so we stay in streaming mode
    render(<LogViewer invocationId={1} isRunning={true} />);

    const es = MockEventSource.instances[0];
    // Emit a log line so loading=false is triggered
    es.emit(
      "log",
      JSON.stringify({ type: "stdout", text: "running output" }),
    );

    await waitFor(() => {
      expect(screen.getByText("Session running...")).toBeInTheDocument();
    });
  });

  it("does NOT show 'Session running...' when isRunning=false", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([{ type: "stdout", text: "done output" }]),
    );
    render(<LogViewer invocationId={1} isRunning={false} />);
    await waitFor(() => {
      expect(screen.getByText("done output")).toBeInTheDocument();
    });
    expect(screen.queryByText("Session running...")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// onCostUpdate callback
// ---------------------------------------------------------------------------

describe("LogViewer onCostUpdate", () => {
  it("calls onCostUpdate with total_cost_usd from SSE log event", async () => {
    const onCostUpdate = vi.fn();
    render(
      <LogViewer invocationId={1} isRunning={true} onCostUpdate={onCostUpdate} />,
    );

    const es = MockEventSource.instances[0];
    es.emit(
      "log",
      JSON.stringify({
        type: "result",
        subtype: "success",
        total_cost_usd: 0.05,
      }),
    );

    await waitFor(() => {
      expect(onCostUpdate).toHaveBeenCalledWith(0.05);
    });
  });

  it("calls onCostUpdate with cost_usd when no total_cost_usd", async () => {
    const onCostUpdate = vi.fn();
    render(
      <LogViewer invocationId={1} isRunning={true} onCostUpdate={onCostUpdate} />,
    );

    const es = MockEventSource.instances[0];
    es.emit(
      "log",
      JSON.stringify({
        type: "result",
        subtype: "success",
        cost_usd: 0.03,
      }),
    );

    await waitFor(() => {
      expect(onCostUpdate).toHaveBeenCalledWith(0.03);
    });
  });
});

// ---------------------------------------------------------------------------
// compact mode
// ---------------------------------------------------------------------------

describe("LogViewer compact mode", () => {
  it("uses max-h-64 when compact=true", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([{ type: "stdout", text: "output" }]),
    );
    const { container } = render(<LogViewer invocationId={1} compact={true} />);
    await waitFor(() => {
      expect(screen.getByText("output")).toBeInTheDocument();
    });
    const scrollEl = container.querySelector(".max-h-64");
    expect(scrollEl).not.toBeNull();
  });

  it("uses max-h-[32rem] when compact=false (default)", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([{ type: "stdout", text: "output" }]),
    );
    const { container } = render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("output")).toBeInTheDocument();
    });
    const scrollEl = container.querySelector(".max-h-\\[32rem\\]");
    expect(scrollEl).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ToolResultBlock — array content
// ---------------------------------------------------------------------------

describe("LogViewer ToolResultBlock array content", () => {
  it("renders tool_result with array content (text items joined)", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "y",
                content: [
                  { type: "text", text: "line one" },
                  { type: "text", text: "line two" },
                ],
              },
            ],
          },
        },
      ]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("↩ result")).toBeInTheDocument();
    });

    // Expand and confirm joined text is shown
    fireEvent.click(screen.getByText("↩ result"));
    await waitFor(() => {
      expect(screen.getByText(/line one/)).toBeInTheDocument();
      expect(screen.getByText(/line two/)).toBeInTheDocument();
    });
  });

  it("renders nothing for tool_result with array of non-text blocks", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "z",
                content: [{ type: "image", text: undefined }],
              },
            ],
          },
        },
      ]),
    );
    render(<LogViewer invocationId={1} />);
    // Wait for loading to finish
    await waitFor(() => {
      expect(screen.queryByText("Loading logs...")).not.toBeInTheDocument();
    });
    // No result button should appear since text is empty
    expect(screen.queryByText("↩ result")).not.toBeInTheDocument();
  });

  it("renders nothing for tool_result block with null content", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "nullcontent",
                // content intentionally omitted (null)
              },
            ],
          },
        },
      ]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading logs...")).not.toBeInTheDocument();
    });
    expect(screen.queryByText("↩ result")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Assistant message with no renderable content
// ---------------------------------------------------------------------------

describe("LogViewer assistant message edge cases", () => {
  it("renders nothing for assistant message with empty text block", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "" }],
          },
        },
        // Add a sentinel so we know loading finished
        { type: "stdout", text: "sentinel-empty-text" },
      ]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("sentinel-empty-text")).toBeInTheDocument();
    });
    // No TextBlock <pre> from the assistant message — the hasContent check
    // filtered it out since text is empty.
    // The only pre rendered is StdoutLine for the sentinel.
    const pres = document.querySelectorAll("pre");
    // None of the <pre> elements should contain the assistant message text (empty string means no meaningful pre)
    // Verify no green-400 TextBlock rendered
    const greenPres = Array.from(pres).filter((el) =>
      el.className.includes("text-green-400"),
    );
    expect(greenPres).toHaveLength(0);
  });

  it("renders nothing for assistant message with no content array", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([
        {
          type: "assistant",
          message: {},
        },
      ]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading logs...")).not.toBeInTheDocument();
    });
    // Falls through to null return — no crash
    expect(screen.queryByText("Session running...")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Timestamp rendering
// ---------------------------------------------------------------------------

describe("LogViewer timestamp rendering", () => {
  it("renders timestamp on stderr line when timestamp field is present", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([
        {
          type: "stderr",
          text: "err with time",
          timestamp: "2024-01-15T14:30:45.000Z",
        },
      ]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("err with time")).toBeInTheDocument();
    });
    // Timestamp formatted as HH:MM:SS — hours depend on local TZ but MM:SS are deterministic
    expect(screen.getByText(/\d{2}:\d{2}:\d{2}/)).toBeInTheDocument();
  });

  it("renders timestamp on stdout line when timestamp field is present", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([
        {
          type: "stdout",
          text: "out with time",
          timestamp: "2024-06-01T08:00:00.000Z",
        },
      ]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("out with time")).toBeInTheDocument();
    });
    expect(screen.getByText(/\d{2}:\d{2}:\d{2}/)).toBeInTheDocument();
  });

  it("does not render timestamp element when timestamp field is absent", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([{ type: "stderr", text: "err no time" }]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("err no time")).toBeInTheDocument();
    });
    expect(screen.queryByText(/\d{2}:\d{2}:\d{2}/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// process_exit codeDescription
// ---------------------------------------------------------------------------

describe("LogViewer ProcessExitLine codeDescription", () => {
  it("renders codeDescription in process_exit line when present", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([
        {
          type: "process_exit",
          code: 1,
          signal: null,
          codeDescription: "Uncaught exception",
        },
      ]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText(/Uncaught exception/)).toBeInTheDocument();
    });
  });

  it("does not include parenthetical when codeDescription is absent", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([{ type: "process_exit", code: 1, signal: null }]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText(/exit 1/)).toBeInTheDocument();
    });
    // No parenthetical description
    const exitEl = screen.getByText(/exit 1/);
    expect(exitEl.textContent).not.toMatch(/\(/);
  });
});

// ---------------------------------------------------------------------------
// system line without subtype
// ---------------------------------------------------------------------------

describe("LogViewer SystemLine without subtype", () => {
  it("renders [system] when subtype is absent", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([{ type: "system" }]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("[system]")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// result line — token count with cache tokens
// ---------------------------------------------------------------------------

describe("LogViewer ResultFooter token calculation", () => {
  it("includes cache tokens in total token count", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([
        {
          type: "result",
          subtype: "success",
          num_turns: 2,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 300,
          },
        },
      ]),
    );
    render(<LogViewer invocationId={1} />);
    // Total = 100 + 50 + 200 + 300 = 650
    await waitFor(() => {
      expect(screen.getByText("Tokens: 650")).toBeInTheDocument();
    });
  });

  it("renders 'unknown' subtype when subtype is absent", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([
        {
          type: "result",
          // no subtype
        },
      ]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("Result: unknown")).toBeInTheDocument();
    });
  });

  it("truncates result text longer than 120 chars", async () => {
    const longResult = "x".repeat(200);
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([
        {
          type: "result",
          subtype: "success",
          result: longResult,
        },
      ]),
    );
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      // Should show only first 120 chars
      expect(screen.getByText("x".repeat(120))).toBeInTheDocument();
    });
    expect(screen.queryByText(longResult)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// onCostUpdate NOT called when no cost fields present
// ---------------------------------------------------------------------------

describe("LogViewer onCostUpdate not called when no cost", () => {
  it("does not call onCostUpdate when result line has no cost fields", async () => {
    const onCostUpdate = vi.fn();
    render(
      <LogViewer invocationId={1} isRunning={true} onCostUpdate={onCostUpdate} />,
    );

    const es = MockEventSource.instances[0];
    es.emit(
      "log",
      JSON.stringify({
        type: "result",
        subtype: "success",
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("Result: success")).toBeInTheDocument();
    });
    expect(onCostUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SSE cleanup on unmount
// ---------------------------------------------------------------------------

describe("LogViewer SSE cleanup on unmount", () => {
  it("closes EventSource when component unmounts during SSE streaming", () => {
    render(<LogViewer invocationId={1} isRunning={true} />);

    const es = MockEventSource.instances[0];
    expect(es.closed).toBe(false);

    // Unmount
    // We need to use the unmount return from render
    const { unmount } = render(<LogViewer invocationId={42} isRunning={true} />);
    const es2 = MockEventSource.instances[MockEventSource.instances.length - 1];
    expect(es2.closed).toBe(false);

    unmount();
    expect(es2.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SSE URL
// ---------------------------------------------------------------------------

describe("LogViewer SSE URL", () => {
  it("connects to the correct SSE endpoint URL", () => {
    render(<LogViewer invocationId={42} isRunning={true} />);
    const es = MockEventSource.instances[MockEventSource.instances.length - 1];
    expect(es.url).toBe("/api/invocations/42/logs/stream");
  });
});

// ---------------------------------------------------------------------------
// compact mode — mutual exclusion of height classes
// ---------------------------------------------------------------------------

describe("LogViewer compact mode mutual exclusion", () => {
  it("does not apply max-h-[32rem] when compact=true", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([{ type: "stdout", text: "output" }]),
    );
    const { container } = render(<LogViewer invocationId={1} compact={true} />);
    await waitFor(() => {
      expect(screen.getByText("output")).toBeInTheDocument();
    });
    const scrollEl = container.querySelector(".max-h-\\[32rem\\]");
    expect(scrollEl).toBeNull();
  });

  it("does not apply max-h-64 when compact=false (default)", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([{ type: "stdout", text: "output" }]),
    );
    const { container } = render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("output")).toBeInTheDocument();
    });
    const scrollEl = container.querySelector(".max-h-64");
    expect(scrollEl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// "renders nothing" false-positive guard — confirm loading ended
// ---------------------------------------------------------------------------

describe("LogViewer renders nothing — loading guard", () => {
  it("renders nothing for user text message AND loading has ended", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([
        { type: "user", message: { content: [{ type: "text", text: "user text" }] } },
        { type: "stdout", text: "sentinel" },
      ]),
    );
    render(<LogViewer invocationId={1} />);
    // The sentinel confirms loading finished and lines were rendered
    await waitFor(() => {
      expect(screen.getByText("sentinel")).toBeInTheDocument();
    });
    expect(screen.queryByText("user text")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// SSE streaming mode
// ---------------------------------------------------------------------------

describe("LogViewer SSE streaming mode", () => {
  it("falls back to fetchInvocationLogs when SSE 'done' fires with no lines", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([{ type: "stdout", text: "fallback line" }]),
    );
    render(<LogViewer invocationId={1} isRunning={true} />);

    const es = MockEventSource.instances[0];
    es.emit("done");

    await waitFor(() => {
      expect(mockFetchInvocationLogs).toHaveBeenCalledWith(1);
      expect(screen.getByText("fallback line")).toBeInTheDocument();
    });
  });

  it("does NOT call fetchInvocationLogs again when SSE 'done' fires after lines received", async () => {
    render(<LogViewer invocationId={1} isRunning={true} />);

    const es = MockEventSource.instances[0];
    // Emit a log line first
    es.emit("log", JSON.stringify({ type: "stdout", text: "sse line" }));
    // Then done
    es.emit("done");

    await waitFor(() => {
      expect(screen.getByText("sse line")).toBeInTheDocument();
    });

    expect(mockFetchInvocationLogs).not.toHaveBeenCalled();
  });

  it("falls back to fetchInvocationLogs on SSE 'error' event", async () => {
    mockFetchInvocationLogs.mockResolvedValue(
      ndjsonResponse([{ type: "stdout", text: "error fallback" }]),
    );
    render(<LogViewer invocationId={1} isRunning={true} />);

    const es = MockEventSource.instances[0];
    es.emit("error");

    await waitFor(() => {
      expect(mockFetchInvocationLogs).toHaveBeenCalledWith(1);
      expect(screen.getByText("error fallback")).toBeInTheDocument();
    });
  });

  it("parses and appends line on SSE 'log' event, sets loading=false", async () => {
    render(<LogViewer invocationId={1} isRunning={true} />);

    const es = MockEventSource.instances[0];
    es.emit("log", JSON.stringify({ type: "stdout", text: "streamed line" }));

    await waitFor(() => {
      expect(screen.getByText("streamed line")).toBeInTheDocument();
    });
    // Loading spinner should be gone
    expect(screen.queryByText("Loading logs...")).not.toBeInTheDocument();
  });
});

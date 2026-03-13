import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
} from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import LogViewer from "../LogViewer";
import { fetchInvocationLogs } from "../../hooks/useApi";

vi.mock("../../hooks/useApi", () => ({
  fetchInvocationLogs: vi.fn(),
}));

const mockFetchInvocationLogs = vi.mocked(fetchInvocationLogs);

// ---------------------------------------------------------------------------
// SSE mock
// ---------------------------------------------------------------------------

class MockEventSource {
  listeners: Record<string, ((e: { data: string }) => void)[]> = {};
  addEventListener(event: string, cb: (e: { data: string }) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(cb);
  }
  close() {}
  dispatch(event: string, data: string) {
    (this.listeners[event] ?? []).forEach((cb) => cb({ data }));
  }
}

let mockES: MockEventSource;

const MockEventSourceConstructor = vi.fn().mockImplementation(function () {
  mockES = new MockEventSource();
  return mockES;
});
// Make it constructable (new EventSource(...))
Object.setPrototypeOf(
  MockEventSourceConstructor.prototype,
  MockEventSource.prototype,
);
vi.stubGlobal("EventSource", MockEventSourceConstructor);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLines(lines: unknown[]) {
  return mockFetchInvocationLogs.mockResolvedValue({ lines });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LogViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. Loading state
  it("shows loading state while fetch is pending", () => {
    mockFetchInvocationLogs.mockReturnValue(new Promise(() => {}));
    render(<LogViewer invocationId={1} />);
    expect(screen.getByText("Loading logs...")).toBeInTheDocument();
  });

  // 2. Error state — no outputSummary
  it("shows error message when fetch fails and no outputSummary", async () => {
    mockFetchInvocationLogs.mockRejectedValue(new Error("fetch failed"));
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("Error: fetch failed")).toBeInTheDocument();
    });
  });

  // 3. Error state — with outputSummary shows fallback
  it("shows fallback with outputSummary when fetch fails", async () => {
    mockFetchInvocationLogs.mockRejectedValue(new Error("fetch failed"));
    render(<LogViewer invocationId={1} outputSummary="Agent crashed early" />);
    await waitFor(() => {
      expect(
        screen.getByText("No log file (agent never started)"),
      ).toBeInTheDocument();
      expect(screen.getByText("Agent crashed early")).toBeInTheDocument();
    });
  });

  // 4. Empty lines — no outputSummary
  it("shows 'No log entries' when lines is empty and no outputSummary", async () => {
    makeLines([]);
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("No log entries")).toBeInTheDocument();
    });
  });

  // 5. Empty lines — with outputSummary shows fallback
  it("shows fallback with outputSummary when lines is empty", async () => {
    makeLines([]);
    render(<LogViewer invocationId={1} outputSummary="Summary text here" />);
    await waitFor(() => {
      expect(
        screen.getByText("No log file (agent never started)"),
      ).toBeInTheDocument();
      expect(screen.getByText("Summary text here")).toBeInTheDocument();
    });
  });

  // 6. Renders stderr line (red, shows text)
  it("renders stderr line in red with text", async () => {
    makeLines([{ type: "stderr", text: "Something went wrong" }]);
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      const el = screen.getByText("Something went wrong");
      expect(el).toBeInTheDocument();
      expect(el.className).toContain("text-red-400");
    });
  });

  // 7. Renders stdout/info line (gray, shows text)
  it("renders stdout line in gray with text", async () => {
    makeLines([{ type: "stdout", text: "Build output line" }]);
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      const el = screen.getByText("Build output line");
      expect(el).toBeInTheDocument();
      expect(el.className).toContain("text-gray-400");
    });
  });

  it("renders info line in gray with text", async () => {
    makeLines([{ type: "info", text: "Info message" }]);
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      const el = screen.getByText("Info message");
      expect(el).toBeInTheDocument();
      expect(el.className).toContain("text-gray-400");
    });
  });

  // 8. Renders system line
  it("renders system line with subtype label (non-init)", async () => {
    makeLines([{ type: "system", subtype: "startup" }]);
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("[system:startup]")).toBeInTheDocument();
    });
  });

  it("renders system line with [system] label when no subtype", async () => {
    makeLines([{ type: "system" }]);
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("[system]")).toBeInTheDocument();
    });
  });

  it("hides system line with subtype 'init'", async () => {
    makeLines([{ type: "system", subtype: "init" }]);
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.queryByText(/\[system/)).not.toBeInTheDocument();
    });
  });

  // 9. Renders process_exit line
  it("renders process_exit with code=0 in gray", async () => {
    makeLines([{ type: "process_exit", code: 0, signal: null }]);
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      const el = screen.getByText(/\[process\]/);
      expect(el.className).toContain("text-gray-500");
      expect(el.textContent).toContain("exit 0");
    });
  });

  it("renders process_exit with non-zero code in yellow", async () => {
    makeLines([{ type: "process_exit", code: 1, signal: null }]);
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      const el = screen.getByText(/\[process\]/);
      expect(el.className).toContain("text-yellow-400");
      expect(el.textContent).toContain("exit 1");
    });
  });

  // 10. Renders result footer with token count and num_turns
  it("renders result footer with token count and num_turns", async () => {
    makeLines([
      {
        type: "result",
        subtype: "success",
        num_turns: 7,
        usage: {
          input_tokens: 1000,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 0,
          output_tokens: 300,
        },
      },
    ]);
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      // total = 1000 + 200 + 0 + 300 = 1500 → "1.5K"
      expect(screen.getByText("Tokens: 1.5K")).toBeInTheDocument();
      expect(screen.getByText("Turns: 7")).toBeInTheDocument();
      expect(screen.getByText("Result: success")).toBeInTheDocument();
    });
  });

  // 11. Renders assistant text block (green pre)
  it("renders assistant text block in green", async () => {
    makeLines([
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Here is my answer." }],
        },
      },
    ]);
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      const el = screen.getByText("Here is my answer.");
      expect(el).toBeInTheDocument();
      expect(el.className).toContain("text-green-400");
    });
  });

  // 12. Renders assistant tool_use block (shows button with tool name, expandable)
  it("renders assistant tool_use block with tool name button that expands", async () => {
    makeLines([
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "read_file",
              input: { path: "/tmp/foo.txt" },
            },
          ],
        },
      },
    ]);
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("read_file")).toBeInTheDocument();
    });

    // Tool input should not be visible yet
    expect(
      screen.queryByText(/"path": "\/tmp\/foo.txt"/),
    ).not.toBeInTheDocument();

    // Click button to expand
    await act(async () => {
      fireEvent.click(screen.getByText("read_file").closest("button")!);
    });
    expect(screen.getByText(/\/tmp\/foo.txt/)).toBeInTheDocument();
  });

  // 13. Renders assistant thinking block (expandable)
  it("renders assistant thinking block expanded by default", async () => {
    makeLines([
      {
        type: "assistant",
        message: {
          content: [{ type: "thinking", thinking: "I should check the file." }],
        },
      },
    ]);
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText("I should check the file.")).toBeInTheDocument();
    });

    // Collapse it
    await act(async () => {
      fireEvent.click(screen.getByText(/Thinking/));
    });
    expect(
      screen.queryByText("I should check the file."),
    ).not.toBeInTheDocument();
  });

  // 14. Renders user tool_result block (expandable)
  it("renders user tool_result block that expands to show content", async () => {
    makeLines([
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-123",
              content: "File content here",
            },
          ],
        },
      },
    ]);
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      expect(screen.getByText(/↩ result/)).toBeInTheDocument();
    });

    // Content should be hidden initially
    expect(screen.queryByText("File content here")).not.toBeInTheDocument();

    // Click to expand
    await act(async () => {
      fireEvent.click(screen.getByText(/↩ result/).closest("button")!);
    });
    expect(screen.getByText("File content here")).toBeInTheDocument();
  });

  // 15. onCostUpdate called with total_cost_usd (via SSE path)
  it("calls onCostUpdate with total_cost_usd when SSE log line has it", async () => {
    const onCostUpdate = vi.fn();
    render(
      <LogViewer invocationId={1} isRunning={true} onCostUpdate={onCostUpdate} />,
    );

    await act(async () => {
      mockES.dispatch(
        "log",
        JSON.stringify({ type: "result", total_cost_usd: 0.42 }),
      );
    });

    await waitFor(() => {
      expect(onCostUpdate).toHaveBeenCalledWith(0.42);
    });
  });

  // 16. onCostUpdate called with cost_usd when total_cost_usd absent (via SSE path)
  it("calls onCostUpdate with cost_usd when total_cost_usd is absent", async () => {
    const onCostUpdate = vi.fn();
    render(
      <LogViewer invocationId={1} isRunning={true} onCostUpdate={onCostUpdate} />,
    );

    await act(async () => {
      mockES.dispatch(
        "log",
        JSON.stringify({ type: "result", cost_usd: 0.15 }),
      );
    });

    await waitFor(() => {
      expect(onCostUpdate).toHaveBeenCalledWith(0.15);
    });
  });

  // 17. compact prop applies max-h-64 instead of max-h-[32rem]
  it("applies max-h-64 class when compact=true", async () => {
    makeLines([{ type: "stderr", text: "line" }]);
    const { container } = render(<LogViewer invocationId={1} compact={true} />);
    await waitFor(() => {
      const scrollable = container.querySelector(".overflow-y-auto");
      expect(scrollable?.className).toContain("max-h-64");
      expect(scrollable?.className).not.toContain("max-h-[32rem]");
    });
  });

  it("applies max-h-[32rem] class when compact is not set", async () => {
    makeLines([{ type: "stderr", text: "line" }]);
    const { container } = render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      const scrollable = container.querySelector(".overflow-y-auto");
      expect(scrollable?.className).toContain("max-h-[32rem]");
      expect(scrollable?.className).not.toContain("max-h-64");
    });
  });

  // 18. SSE streaming: isRunning=true creates EventSource, "log" events update lines
  it("SSE streaming: creates EventSource and updates lines on log events", async () => {
    render(<LogViewer invocationId={42} isRunning={true} />);

    // EventSource should have been created
    expect(EventSource).toHaveBeenCalledWith(
      "/api/invocations/42/logs/stream",
    );

    // Dispatch a log event
    await act(async () => {
      mockES.dispatch(
        "log",
        JSON.stringify({ type: "stderr", text: "streaming line" }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText("streaming line")).toBeInTheDocument();
    });
  });

  it("SSE streaming: done event with no lines falls back to fetchInvocationLogs", async () => {
    mockFetchInvocationLogs.mockResolvedValue({
      lines: [{ type: "stderr", text: "from disk" }],
    });
    render(<LogViewer invocationId={42} isRunning={true} />);

    // Dispatch done without any log lines first
    await act(async () => {
      mockES.dispatch("done", "");
    });

    await waitFor(() => {
      expect(mockFetchInvocationLogs).toHaveBeenCalledWith(42);
      expect(screen.getByText("from disk")).toBeInTheDocument();
    });
  });

  // 19. SSE error event falls back to fetchInvocationLogs
  it("SSE error event falls back to fetchInvocationLogs", async () => {
    mockFetchInvocationLogs.mockResolvedValue({
      lines: [{ type: "stderr", text: "error fallback line" }],
    });
    render(<LogViewer invocationId={42} isRunning={true} />);

    await act(async () => {
      mockES.dispatch("error", "");
    });

    await waitFor(() => {
      expect(mockFetchInvocationLogs).toHaveBeenCalledWith(42);
      expect(screen.getByText("error fallback line")).toBeInTheDocument();
    });
  });

  // 20. Auto-scroll: jump button appears when scrolled up, hidden at bottom
  it("jump button appears when scrolled far from bottom, hidden when at bottom", async () => {
    makeLines([{ type: "stderr", text: "line" }]);
    const { container } = render(<LogViewer invocationId={1} />);
    await waitFor(() => screen.getByText("line"));

    const scrollable = container.querySelector(".overflow-y-auto")!;

    // Initially jump button is not shown (pinned at bottom by default)
    expect(
      screen.queryByText("↓ Jump to bottom"),
    ).not.toBeInTheDocument();

    // Simulate user scrolling up — make distanceFromBottom >= 50
    Object.defineProperty(scrollable, "scrollHeight", {
      value: 1000,
      configurable: true,
    });
    Object.defineProperty(scrollable, "clientHeight", {
      value: 400,
      configurable: true,
    });
    Object.defineProperty(scrollable, "scrollTop", {
      value: 0,
      configurable: true,
      writable: true,
    });

    await act(async () => {
      fireEvent.scroll(scrollable);
    });

    expect(screen.getByText("↓ Jump to bottom")).toBeInTheDocument();

    // Simulate scrolling to bottom — distanceFromBottom < 50
    Object.defineProperty(scrollable, "scrollTop", {
      value: 600,
      configurable: true,
      writable: true,
    });

    await act(async () => {
      fireEvent.scroll(scrollable);
    });

    expect(
      screen.queryByText("↓ Jump to bottom"),
    ).not.toBeInTheDocument();
  });

  // 21. Auto-scroll: clicking jump button hides it and scrolls to bottom
  it("clicking jump button hides it and scrolls container to bottom", async () => {
    makeLines([{ type: "stderr", text: "line" }]);
    const { container } = render(<LogViewer invocationId={1} />);
    await waitFor(() => screen.getByText("line"));

    const scrollable = container.querySelector(".overflow-y-auto")!;

    // Scroll up to show the jump button
    Object.defineProperty(scrollable, "scrollHeight", {
      value: 1000,
      configurable: true,
    });
    Object.defineProperty(scrollable, "clientHeight", {
      value: 400,
      configurable: true,
    });
    Object.defineProperty(scrollable, "scrollTop", {
      value: 0,
      configurable: true,
      writable: true,
    });

    await act(async () => {
      fireEvent.scroll(scrollable);
    });

    expect(screen.getByText("↓ Jump to bottom")).toBeInTheDocument();

    // Click the jump button
    await act(async () => {
      fireEvent.click(screen.getByText("↓ Jump to bottom"));
    });

    // Button should be gone
    expect(
      screen.queryByText("↓ Jump to bottom"),
    ).not.toBeInTheDocument();

    // scrollTop should have been set to scrollHeight (1000)
    expect(scrollable.scrollTop).toBe(1000);
  });

  // Note: LogViewer has no search/filter UI — that acceptance criterion does not apply.

  // Additional: user messages without tool_result are skipped
  it("does not render user messages that have no tool_result blocks", async () => {
    makeLines([
      {
        type: "user",
        message: {
          content: [{ type: "text", text: "plain user text" }],
        },
      },
    ]);
    render(<LogViewer invocationId={1} />);
    await waitFor(() => {
      // Loader disappears, empty state shown (user message rendered null)
      expect(screen.queryByText("plain user text")).not.toBeInTheDocument();
    });
  });
});

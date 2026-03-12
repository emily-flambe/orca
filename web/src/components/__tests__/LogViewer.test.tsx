import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
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
  listeners: Record<string, ((e: { data: string }) => void)[]> = {};
  url: string;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (e: { data: string }) => void) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }

  dispatchEvent(type: string, data: string) {
    this.listeners[type]?.forEach((fn) => fn({ data }));
  }

  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderLogViewer(
  props: Partial<Parameters<typeof LogViewer>[0]> = {},
) {
  return render(
    <LogViewer
      invocationId={1}
      isRunning={false}
      {...props}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LogViewer", () => {
  describe("loading state", () => {
    it("shows 'Loading logs...' initially", () => {
      // Never resolves so we stay in loading
      mockFetchInvocationLogs.mockReturnValue(new Promise(() => {}));
      renderLogViewer();
      expect(screen.getByText("Loading logs...")).toBeInTheDocument();
    });
  });

  describe("error state", () => {
    it("shows 'Error: <message>' when fetch fails and no outputSummary", async () => {
      mockFetchInvocationLogs.mockRejectedValue(new Error("Network error"));
      renderLogViewer();
      await waitFor(() => {
        expect(screen.getByText("Error: Network error")).toBeInTheDocument();
      });
    });

    it("shows 'No log file (agent never started)' and outputSummary when fetch fails with outputSummary", async () => {
      mockFetchInvocationLogs.mockRejectedValue(new Error("Not found"));
      renderLogViewer({ outputSummary: "Agent crashed on startup" });
      await waitFor(() => {
        expect(
          screen.getByText("No log file (agent never started)"),
        ).toBeInTheDocument();
        expect(
          screen.getByText("Agent crashed on startup"),
        ).toBeInTheDocument();
      });
    });

    it("does not show error message text when outputSummary is provided on error", async () => {
      mockFetchInvocationLogs.mockRejectedValue(new Error("Not found"));
      renderLogViewer({ outputSummary: "Agent crashed on startup" });
      await waitFor(() => {
        expect(screen.queryByText(/Error: Not found/)).not.toBeInTheDocument();
      });
    });
  });

  describe("empty state", () => {
    it("shows 'No log entries' when lines array is empty and no outputSummary", async () => {
      mockFetchInvocationLogs.mockResolvedValue({ lines: [] });
      renderLogViewer();
      await waitFor(() => {
        expect(screen.getByText("No log entries")).toBeInTheDocument();
      });
    });

    it("shows 'No log file (agent never started)' and outputSummary when lines empty with outputSummary", async () => {
      mockFetchInvocationLogs.mockResolvedValue({ lines: [] });
      renderLogViewer({ outputSummary: "Task was skipped" });
      await waitFor(() => {
        expect(
          screen.getByText("No log file (agent never started)"),
        ).toBeInTheDocument();
        expect(screen.getByText("Task was skipped")).toBeInTheDocument();
      });
    });
  });

  describe("system lines", () => {
    it("skips system lines with subtype 'init'", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "system", subtype: "init" }],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(screen.queryByText(/\[system/)).not.toBeInTheDocument();
      });
    });

    it("renders '[system]' label for system lines without subtype", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "system" }],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(screen.getByText("[system]")).toBeInTheDocument();
      });
    });

    it("renders '[system:subtype]' for system lines with non-init subtype", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "system", subtype: "error" }],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(screen.getByText("[system:error]")).toBeInTheDocument();
      });
    });
  });

  describe("stderr lines", () => {
    it("renders stderr line text", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "stderr", text: "fatal: something went wrong" }],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(
          screen.getByText("fatal: something went wrong"),
        ).toBeInTheDocument();
      });
    });

    it("renders stderr in a <pre> element with red text class", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "stderr", text: "error output" }],
      });
      renderLogViewer();
      await waitFor(() => {
        const pre = screen.getByText("error output");
        expect(pre.tagName).toBe("PRE");
        expect(pre.className).toContain("text-red-400");
      });
    });
  });

  describe("stdout and info lines", () => {
    it("renders stdout line text", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "stdout", text: "Standard output text" }],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(screen.getByText("Standard output text")).toBeInTheDocument();
      });
    });

    it("renders info line text", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "info", text: "Info line content" }],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(screen.getByText("Info line content")).toBeInTheDocument();
      });
    });

    it("renders stdout in a <pre> with gray text class", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "stdout", text: "gray text" }],
      });
      renderLogViewer();
      await waitFor(() => {
        const pre = screen.getByText("gray text");
        expect(pre.tagName).toBe("PRE");
        expect(pre.className).toContain("text-gray-400");
      });
    });
  });

  describe("process_exit lines", () => {
    it("renders '[process] exit 0' for normal exit (code=0, no signal)", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "process_exit", code: 0, signal: null }],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(screen.getByText(/\[process\] exit 0/)).toBeInTheDocument();
      });
    });

    it("uses gray color class for normal exit (code=0)", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "process_exit", code: 0, signal: null }],
      });
      renderLogViewer();
      await waitFor(() => {
        const el = screen.getByText(/\[process\] exit 0/);
        expect(el.className).toContain("text-gray-500");
      });
    });

    it("renders signal info for signal-terminated process", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "process_exit", code: null, signal: "SIGKILL" }],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(
          screen.getByText(/\[process\] signal SIGKILL/),
        ).toBeInTheDocument();
      });
    });

    it("uses yellow color class for abnormal exit", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "process_exit", code: 1, signal: null }],
      });
      renderLogViewer();
      await waitFor(() => {
        const el = screen.getByText(/\[process\] exit 1/);
        expect(el.className).toContain("text-yellow-400");
      });
    });

    it("renders non-zero exit code", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "process_exit", code: 137, signal: null }],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(screen.getByText(/\[process\] exit 137/)).toBeInTheDocument();
      });
    });
  });

  describe("result footer", () => {
    it("renders 'Result: <subtype>'", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "result", subtype: "success" }],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(screen.getByText("Result: success")).toBeInTheDocument();
      });
    });

    it("renders 'Result: unknown' when subtype is missing", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "result" }],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(screen.getByText("Result: unknown")).toBeInTheDocument();
      });
    });

    it("renders token count using formatTokens — 1234 tokens displays as 1.2K", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [
          {
            type: "result",
            subtype: "success",
            usage: {
              input_tokens: 1000,
              cache_creation_input_tokens: 100,
              cache_read_input_tokens: 50,
              output_tokens: 84,
            },
          },
        ],
      });
      // Total = 1000 + 100 + 50 + 84 = 1234
      renderLogViewer();
      await waitFor(() => {
        expect(screen.getByText("Tokens: 1.2K")).toBeInTheDocument();
      });
    });

    it("renders token count — 45000 total displays as 45K", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [
          {
            type: "result",
            subtype: "success",
            usage: {
              input_tokens: 40000,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 5000,
            },
          },
        ],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(screen.getByText("Tokens: 45K")).toBeInTheDocument();
      });
    });

    it("renders token count — 1234567 total displays as 1.2M", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [
          {
            type: "result",
            subtype: "success",
            usage: {
              input_tokens: 1200000,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 34567,
            },
          },
        ],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(screen.getByText("Tokens: 1.2M")).toBeInTheDocument();
      });
    });

    it("renders num_turns when present", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "result", subtype: "success", num_turns: 7 }],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(screen.getByText("Turns: 7")).toBeInTheDocument();
      });
    });

    it("renders truncated result text", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [
          {
            type: "result",
            subtype: "success",
            result: "The task has been completed successfully.",
          },
        ],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(
          screen.getByText("The task has been completed successfully."),
        ).toBeInTheDocument();
      });
    });

    it("does not render Tokens when usage is absent", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "result", subtype: "success" }],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(screen.queryByText(/Tokens:/)).not.toBeInTheDocument();
      });
    });
  });

  describe("assistant text block", () => {
    it("renders assistant text in a green pre element", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Hello from the agent" }],
            },
          },
        ],
      });
      renderLogViewer();
      await waitFor(() => {
        const pre = screen.getByText("Hello from the agent");
        expect(pre.tagName).toBe("PRE");
        expect(pre.className).toContain("text-green-400");
      });
    });
  });

  describe("assistant tool_use block", () => {
    it("renders a button with the tool name", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [
          {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  name: "Bash",
                  input: { command: "ls -la" },
                },
              ],
            },
          },
        ],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(screen.getByText("Bash")).toBeInTheDocument();
      });
    });

    it("is closed by default — does not show input JSON", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [
          {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  name: "Read",
                  input: { file_path: "/tmp/secret.txt" },
                },
              ],
            },
          },
        ],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(screen.getByText("Read")).toBeInTheDocument();
        expect(
          screen.queryByText(/file_path/),
        ).not.toBeInTheDocument();
      });
    });

    it("expands input JSON when button is clicked", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [
          {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  name: "Write",
                  input: { file_path: "/out.txt" },
                },
              ],
            },
          },
        ],
      });
      renderLogViewer();
      await waitFor(() => screen.getByText("Write"));
      // Click the button (find the closest button wrapper)
      const btn = screen.getByRole("button", { name: /Write/ });
      fireEvent.click(btn);
      expect(screen.getByText(/file_path/)).toBeInTheDocument();
    });

    it("collapses input JSON when clicked again", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [
          {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  name: "Glob",
                  input: { pattern: "**/*.ts" },
                },
              ],
            },
          },
        ],
      });
      renderLogViewer();
      await waitFor(() => screen.getByText("Glob"));
      const btn = screen.getByRole("button", { name: /Glob/ });
      fireEvent.click(btn); // expand
      expect(screen.getByText(/pattern/)).toBeInTheDocument();
      fireEvent.click(btn); // collapse
      expect(screen.queryByText(/pattern/)).not.toBeInTheDocument();
    });
  });

  describe("assistant thinking block", () => {
    it("renders thinking content open by default", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [
          {
            type: "assistant",
            message: {
              content: [
                {
                  type: "thinking",
                  thinking: "Let me think about this carefully...",
                },
              ],
            },
          },
        ],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(
          screen.getByText("Let me think about this carefully..."),
        ).toBeInTheDocument();
      });
    });

    it("renders 'Thinking…' toggle button", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [
          {
            type: "assistant",
            message: {
              content: [
                { type: "thinking", thinking: "Some internal reasoning" },
              ],
            },
          },
        ],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(screen.getByText(/Thinking…/)).toBeInTheDocument();
      });
    });

    it("collapses when the thinking button is clicked", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [
          {
            type: "assistant",
            message: {
              content: [{ type: "thinking", thinking: "Deep thought here" }],
            },
          },
        ],
      });
      renderLogViewer();
      await waitFor(() => screen.getByText(/Thinking…/));
      fireEvent.click(screen.getByText(/Thinking…/));
      expect(screen.queryByText("Deep thought here")).not.toBeInTheDocument();
    });

    it("re-expands when clicked again after collapsing", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [
          {
            type: "assistant",
            message: {
              content: [{ type: "thinking", thinking: "Persistent thought" }],
            },
          },
        ],
      });
      renderLogViewer();
      await waitFor(() => screen.getByText(/Thinking…/));
      const btn = screen.getByText(/Thinking…/);
      fireEvent.click(btn); // collapse
      fireEvent.click(btn); // re-expand
      expect(screen.getByText("Persistent thought")).toBeInTheDocument();
    });
  });

  describe("user tool_result block", () => {
    it("renders collapsed '↩ result' button by default", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [
          {
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool_abc",
                  content: "The command output",
                },
              ],
            },
          },
        ],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(screen.getByText("↩ result")).toBeInTheDocument();
        expect(
          screen.queryByText("The command output"),
        ).not.toBeInTheDocument();
      });
    });

    it("expands result content when '↩ result' is clicked", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [
          {
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool_xyz",
                  content: "Command succeeded with output",
                },
              ],
            },
          },
        ],
      });
      renderLogViewer();
      await waitFor(() => screen.getByText("↩ result"));
      fireEvent.click(screen.getByText("↩ result"));
      expect(
        screen.getByText("Command succeeded with output"),
      ).toBeInTheDocument();
    });

    it("collapses result content when clicked again", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [
          {
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool_xyz",
                  content: "Some output text",
                },
              ],
            },
          },
        ],
      });
      renderLogViewer();
      await waitFor(() => screen.getByText("↩ result"));
      fireEvent.click(screen.getByText("↩ result")); // expand
      fireEvent.click(screen.getByText("↩ result")); // collapse
      expect(screen.queryByText("Some output text")).not.toBeInTheDocument();
    });

    it("renders tool_result with array content blocks", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [
          {
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool_arr",
                  content: [
                    { type: "text", text: "First block" },
                    { type: "text", text: "Second block" },
                  ],
                },
              ],
            },
          },
        ],
      });
      renderLogViewer();
      await waitFor(() => screen.getByText("↩ result"));
      fireEvent.click(screen.getByText("↩ result"));
      expect(screen.getByText(/First block/)).toBeInTheDocument();
    });

    it("does not render ↩ result button when content is empty string", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [
          {
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool_empty",
                  content: "",
                },
              ],
            },
          },
        ],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(
          screen.queryByText("↩ result"),
        ).not.toBeInTheDocument();
      });
    });

    it("skips user lines with no tool_result blocks", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [
          {
            type: "user",
            message: {
              content: [{ type: "text", text: "user prompt text" }],
            },
          },
        ],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(screen.queryByText("↩ result")).not.toBeInTheDocument();
        expect(screen.queryByText("user prompt text")).not.toBeInTheDocument();
      });
    });
  });

  describe("isRunning=true — SSE mode", () => {
    it("creates EventSource at the correct URL", async () => {
      // isRunning=true — never resolves the fetch fallback
      mockFetchInvocationLogs.mockReturnValue(new Promise(() => {}));
      renderLogViewer({ invocationId: 42, isRunning: true });
      // Wait briefly for the effect to fire
      await act(async () => {});
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
      expect(MockEventSource.instances[0].url).toBe(
        "/api/invocations/42/logs/stream",
      );
    });

    it("shows 'Session running...' indicator when isRunning=true and lines exist", async () => {
      mockFetchInvocationLogs.mockReturnValue(new Promise(() => {}));
      renderLogViewer({ invocationId: 1, isRunning: true });

      await act(async () => {
        const es = MockEventSource.instances[0];
        es.dispatchEvent(
          "log",
          JSON.stringify({ type: "stdout", text: "some output" }),
        );
      });

      expect(screen.getByText("Session running...")).toBeInTheDocument();
    });

    it("appends log lines from SSE 'log' events", async () => {
      mockFetchInvocationLogs.mockReturnValue(new Promise(() => {}));
      renderLogViewer({ invocationId: 1, isRunning: true });

      await act(async () => {
        const es = MockEventSource.instances[0];
        es.dispatchEvent(
          "log",
          JSON.stringify({ type: "stdout", text: "line from SSE" }),
        );
      });

      expect(screen.getByText("line from SSE")).toBeInTheDocument();
    });

    it("appends multiple log lines from successive SSE 'log' events", async () => {
      mockFetchInvocationLogs.mockReturnValue(new Promise(() => {}));
      renderLogViewer({ invocationId: 1, isRunning: true });

      await act(async () => {
        const es = MockEventSource.instances[0];
        es.dispatchEvent(
          "log",
          JSON.stringify({ type: "stdout", text: "first line" }),
        );
        es.dispatchEvent(
          "log",
          JSON.stringify({ type: "stdout", text: "second line" }),
        );
      });

      expect(screen.getByText("first line")).toBeInTheDocument();
      expect(screen.getByText("second line")).toBeInTheDocument();
    });

    it("calls onCostUpdate when log line contains total_cost_usd", async () => {
      mockFetchInvocationLogs.mockReturnValue(new Promise(() => {}));
      const onCostUpdate = vi.fn();
      renderLogViewer({ invocationId: 1, isRunning: true, onCostUpdate });

      await act(async () => {
        const es = MockEventSource.instances[0];
        es.dispatchEvent(
          "log",
          JSON.stringify({
            type: "result",
            subtype: "success",
            total_cost_usd: 0.05,
          }),
        );
      });

      expect(onCostUpdate).toHaveBeenCalledWith(0.05);
    });

    it("calls onCostUpdate when log line contains cost_usd", async () => {
      mockFetchInvocationLogs.mockReturnValue(new Promise(() => {}));
      const onCostUpdate = vi.fn();
      renderLogViewer({ invocationId: 1, isRunning: true, onCostUpdate });

      await act(async () => {
        const es = MockEventSource.instances[0];
        es.dispatchEvent(
          "log",
          JSON.stringify({
            type: "result",
            subtype: "success",
            cost_usd: 0.12,
          }),
        );
      });

      expect(onCostUpdate).toHaveBeenCalledWith(0.12);
    });

    it("does not call onCostUpdate when log line has no cost field", async () => {
      mockFetchInvocationLogs.mockReturnValue(new Promise(() => {}));
      const onCostUpdate = vi.fn();
      renderLogViewer({ invocationId: 1, isRunning: true, onCostUpdate });

      await act(async () => {
        const es = MockEventSource.instances[0];
        es.dispatchEvent(
          "log",
          JSON.stringify({ type: "stdout", text: "no cost here" }),
        );
      });

      expect(onCostUpdate).not.toHaveBeenCalled();
    });

    it("falls back to fetchInvocationLogs on 'done' event when no lines received", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "stdout", text: "from fallback fetch" }],
      });
      renderLogViewer({ invocationId: 1, isRunning: true });

      await act(async () => {
        const es = MockEventSource.instances[0];
        es.dispatchEvent("done", "");
      });

      await waitFor(() => {
        expect(mockFetchInvocationLogs).toHaveBeenCalledWith(1);
        expect(screen.getByText("from fallback fetch")).toBeInTheDocument();
      });
    });

    it("does NOT call fetchInvocationLogs on 'done' event when lines were received", async () => {
      mockFetchInvocationLogs.mockReturnValue(new Promise(() => {}));
      renderLogViewer({ invocationId: 1, isRunning: true });

      await act(async () => {
        const es = MockEventSource.instances[0];
        es.dispatchEvent(
          "log",
          JSON.stringify({ type: "stdout", text: "already received" }),
        );
        es.dispatchEvent("done", "");
      });

      // fetchInvocationLogs should NOT have been called (it returns never-resolving promise but we haven't called it yet)
      expect(mockFetchInvocationLogs).not.toHaveBeenCalled();
    });

    it("falls back to fetchInvocationLogs on SSE 'error' event", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "stdout", text: "recovered from SSE error" }],
      });
      renderLogViewer({ invocationId: 1, isRunning: true });

      await act(async () => {
        const es = MockEventSource.instances[0];
        es.dispatchEvent("error", "");
      });

      await waitFor(() => {
        expect(mockFetchInvocationLogs).toHaveBeenCalledWith(1);
        expect(
          screen.getByText("recovered from SSE error"),
        ).toBeInTheDocument();
      });
    });

    it("closes EventSource when component unmounts", async () => {
      mockFetchInvocationLogs.mockReturnValue(new Promise(() => {}));
      const { unmount } = renderLogViewer({ invocationId: 1, isRunning: true });
      await act(async () => {});

      const es = MockEventSource.instances[0];
      expect(es.closed).toBe(false);
      unmount();
      expect(es.closed).toBe(true);
    });
  });

  describe("compact prop", () => {
    it("applies max-h-64 class when compact=true", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "stdout", text: "compact content" }],
      });
      renderLogViewer({ compact: true });
      await waitFor(() => screen.getByText("compact content"));
      const container = screen
        .getByText("compact content")
        .closest(".overflow-y-auto");
      expect(container?.className).toContain("max-h-64");
    });

    it("applies max-h-[32rem] class when compact is not set", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [{ type: "stdout", text: "non-compact content" }],
      });
      renderLogViewer({ compact: false });
      await waitFor(() => screen.getByText("non-compact content"));
      const container = screen
        .getByText("non-compact content")
        .closest(".overflow-y-auto");
      expect(container?.className).toContain("max-h-[32rem]");
    });
  });

  describe("multiple line types rendered together", () => {
    it("renders a mix of stderr, stdout, and system lines", async () => {
      mockFetchInvocationLogs.mockResolvedValue({
        lines: [
          { type: "system", subtype: "start" },
          { type: "stdout", text: "Building..." },
          { type: "stderr", text: "Warning: deprecated API" },
          { type: "stdout", text: "Done." },
          { type: "process_exit", code: 0, signal: null },
        ],
      });
      renderLogViewer();
      await waitFor(() => {
        expect(screen.getByText("[system:start]")).toBeInTheDocument();
        expect(screen.getByText("Building...")).toBeInTheDocument();
        expect(screen.getByText("Warning: deprecated API")).toBeInTheDocument();
        expect(screen.getByText("Done.")).toBeInTheDocument();
        expect(screen.getByText(/\[process\] exit 0/)).toBeInTheDocument();
      });
    });
  });
});

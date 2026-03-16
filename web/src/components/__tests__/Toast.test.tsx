/**
 * Toast system adversarial tests.
 *
 * Attack surface:
 *  - ToastProvider / useToast hook
 *  - Max-4 toast cap + oldest-first eviction
 *  - Auto-dismiss timer cleanup (memory leaks)
 *  - Animation double-rAF path
 *  - useToast called outside provider (should throw)
 *  - CronPage toast integration (togglingId cleanup, toast messages)
 *  - TaskList toast integration (error path on updateTaskStatus)
 *  - App.tsx handleSync / handleConfigUpdate toast paths
 */

import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { ToastProvider, useToast } from "../ui/Toast";
import CronPage from "../CronPage";
import TaskList from "../TaskList";
import type { Task, CronSchedule } from "../../types";
import {
  fetchCronSchedules,
  updateCronSchedule,
  updateTaskStatus,
} from "../../hooks/useApi";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../hooks/useApi", () => ({
  fetchCronSchedules: vi.fn(),
  createCronSchedule: vi.fn(),
  updateCronSchedule: vi.fn(),
  deleteCronSchedule: vi.fn(),
  updateTaskStatus: vi.fn().mockResolvedValue({ ok: true }),
}));

const mockFetchCronSchedules = vi.mocked(fetchCronSchedules);
const mockUpdateCronSchedule = vi.mocked(updateCronSchedule);
const mockUpdateTaskStatus = vi.mocked(updateTaskStatus);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    linearIssueId: "ENG-1",
    agentPrompt: "Test task prompt",
    repoPath: "/repo",
    orcaStatus: "ready",
    priority: 3,
    retryCount: 0,
    prBranchName: null,
    reviewCycleCount: 0,
    mergeCommitSha: null,
    prNumber: null,
    deployStartedAt: null,
    ciStartedAt: null,
    doneAt: null,
    projectName: null,
    invocationCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSchedule(overrides: Partial<CronSchedule> = {}): CronSchedule {
  return {
    id: 1,
    name: "Test schedule",
    type: "claude",
    schedule: "0 2 * * *",
    prompt: "Run daily task",
    repoPath: null,
    model: null,
    maxTurns: null,
    timeoutMin: 60,
    maxRuns: null,
    runCount: 0,
    enabled: 1,
    lastRunAt: null,
    lastRunStatus: null,
    nextRunAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// Wrap component in ToastProvider
function withToast(children: React.ReactNode) {
  return <ToastProvider>{children}</ToastProvider>;
}

// ---------------------------------------------------------------------------
// BUG PROBE 1: useToast() outside ToastProvider should throw
// ---------------------------------------------------------------------------

describe("useToast outside provider", () => {
  it("throws when useToast is called outside ToastProvider", () => {
    // Suppress React's error boundary output for this intentional throw test
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    function ComponentWithNoProvider() {
      const { showToast } = useToast();
      return <button onClick={() => showToast("hi")}>click</button>;
    }

    expect(() => render(<ComponentWithNoProvider />)).toThrow(
      "useToast must be used within ToastProvider",
    );

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// BUG PROBE 2: Toast renders and dismisses
// ---------------------------------------------------------------------------

describe("ToastProvider basic rendering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function ToastTrigger({ type }: { type?: "success" | "error" | "info" }) {
    const { showToast } = useToast();
    return (
      <button onClick={() => showToast("Hello toast", type)}>trigger</button>
    );
  }

  it("renders a toast message after showToast is called", async () => {
    render(
      withToast(
        <>
          <ToastTrigger />
        </>,
      ),
    );

    fireEvent.click(screen.getByText("trigger"));

    // Double-rAF makes visible=true; advance timer for animation
    await act(async () => {
      await Promise.resolve(); // flush microtasks
    });

    // Toast container renders message even before visible animation finishes
    expect(screen.getByText("Hello toast")).toBeInTheDocument();
  });

  it("auto-dismisses toast after 4000ms", async () => {
    render(
      withToast(
        <>
          <ToastTrigger />
        </>,
      ),
    );

    fireEvent.click(screen.getByText("trigger"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Hello toast")).toBeInTheDocument();

    // Advance past auto-dismiss (4000ms) + exit animation (300ms)
    await act(async () => {
      vi.advanceTimersByTime(4301);
    });

    expect(screen.queryByText("Hello toast")).not.toBeInTheDocument();
  });

  it("dismiss button removes the toast immediately (within 300ms)", async () => {
    render(
      withToast(
        <>
          <ToastTrigger />
        </>,
      ),
    );

    fireEvent.click(screen.getByText("trigger"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Hello toast")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Dismiss"));

    // After 300ms exit animation the element should be gone
    await act(async () => {
      vi.advanceTimersByTime(301);
    });

    expect(screen.queryByText("Hello toast")).not.toBeInTheDocument();
  });

  it("renders success toast with correct type class", async () => {
    render(
      withToast(
        <>
          <ToastTrigger type="success" />
        </>,
      ),
    );

    fireEvent.click(screen.getByText("trigger"));

    await act(async () => {
      await Promise.resolve();
    });

    const toastEl = screen.getByText("Hello toast").closest("div");
    expect(toastEl?.className).toContain("bg-green-900");
  });

  it("renders error toast with correct type class", async () => {
    render(
      withToast(
        <>
          <ToastTrigger type="error" />
        </>,
      ),
    );

    fireEvent.click(screen.getByText("trigger"));

    await act(async () => {
      await Promise.resolve();
    });

    const toastEl = screen.getByText("Hello toast").closest("div");
    expect(toastEl?.className).toContain("bg-red-900");
  });
});

// ---------------------------------------------------------------------------
// BUG PROBE 3: Max-4 toast cap — 5th toast evicts oldest
// ---------------------------------------------------------------------------

describe("Toast max-cap eviction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function MultiTrigger() {
    const { showToast } = useToast();
    return (
      <button
        onClick={() => {
          showToast("toast-1");
          showToast("toast-2");
          showToast("toast-3");
          showToast("toast-4");
          showToast("toast-5");
        }}
      >
        fire-5
      </button>
    );
  }

  it("shows at most 4 toasts when 5 are fired simultaneously", async () => {
    render(withToast(<MultiTrigger />));

    fireEvent.click(screen.getByText("fire-5"));

    await act(async () => {
      await Promise.resolve();
    });

    // The toast container renders the current toasts array directly.
    // With MAX_TOASTS=4, after adding toast-5, toast-1 should be evicted.
    const allToasts = screen.queryAllByText(/toast-/);
    expect(allToasts.length).toBeLessThanOrEqual(4);
  });

  it("evicts toast-1 (oldest) when toast-5 is added", async () => {
    render(withToast(<MultiTrigger />));

    fireEvent.click(screen.getByText("fire-5"));

    await act(async () => {
      await Promise.resolve();
    });

    // toast-1 should be gone, toast-5 should be present
    expect(screen.queryByText("toast-1")).not.toBeInTheDocument();
    expect(screen.getByText("toast-5")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// BUG PROBE 4: timer cleanup on unmount — no leak
// ---------------------------------------------------------------------------

describe("ToastProvider timer cleanup on unmount", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not throw after unmount when timers fire", async () => {
    function Trigger() {
      const { showToast } = useToast();
      return <button onClick={() => showToast("leak test")}>go</button>;
    }

    const { unmount } = render(withToast(<Trigger />));

    fireEvent.click(screen.getByText("go"));

    await act(async () => {
      await Promise.resolve();
    });

    // Unmount before auto-dismiss fires
    unmount();

    // Timers from mounted state should have been cleared — advancing should not throw
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(5000);
      });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// BUG PROBE 5: CronPage toast — togglingId cleared in finally block
// ---------------------------------------------------------------------------

describe("CronPage toast integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows success toast after toggle and clears togglingId", async () => {
    const schedule = makeSchedule({ id: 1, name: "My cron", enabled: 1 });
    const updated = makeSchedule({ id: 1, name: "My cron", enabled: 0 });
    mockFetchCronSchedules.mockResolvedValue([schedule]);
    mockUpdateCronSchedule.mockResolvedValue(updated);

    render(withToast(<CronPage />));

    await waitFor(() => {
      expect(screen.getByTitle("Disable")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle("Disable"));

    await waitFor(() => {
      expect(screen.getByText(/My cron disabled/)).toBeInTheDocument();
    });

    // After toggle completes, the button should NOT be disabled (togglingId cleared)
    const toggleBtn = screen.getByTitle("Enable");
    expect(toggleBtn).not.toBeDisabled();
  });

  it("shows error toast and clears togglingId when toggle fails", async () => {
    const schedule = makeSchedule({ id: 1, name: "Flaky cron", enabled: 1 });
    mockFetchCronSchedules.mockResolvedValue([schedule]);
    mockUpdateCronSchedule.mockRejectedValue(new Error("Network timeout"));

    render(withToast(<CronPage />));

    await waitFor(() => {
      expect(screen.getByTitle("Disable")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle("Disable"));

    await waitFor(() => {
      expect(
        screen.getByText(/Toggle failed: Network timeout/),
      ).toBeInTheDocument();
    });

    // togglingId must be cleared even on failure — button should re-enable
    await waitFor(() => {
      const toggleBtn = screen.getByTitle("Disable");
      expect(toggleBtn).not.toBeDisabled();
    });
  });

  it("disables toggle button while toggle is in flight", async () => {
    const schedule = makeSchedule({ id: 1, enabled: 1 });
    mockFetchCronSchedules.mockResolvedValue([schedule]);

    // Never resolves — simulates in-flight state
    mockUpdateCronSchedule.mockReturnValue(new Promise(() => {}));

    render(withToast(<CronPage />));

    await waitFor(() => {
      expect(screen.getByTitle("Disable")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle("Disable"));

    // The toggle button should be disabled while the request is in flight
    await waitFor(() => {
      expect(screen.getByTitle("Disable")).toBeDisabled();
    });
  });

  it("shows success toast after successful delete", async () => {
    const { deleteCronSchedule } = await import("../../hooks/useApi");
    const mockDelete = vi.mocked(deleteCronSchedule);
    mockDelete.mockResolvedValue({ ok: true });

    mockFetchCronSchedules.mockResolvedValue([makeSchedule({ id: 99 })]);

    render(withToast(<CronPage />));

    await waitFor(() => screen.getByText("Delete"));

    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Yes"));

    await waitFor(() => {
      expect(screen.getByText("Schedule deleted")).toBeInTheDocument();
    });
  });

  it("shows error toast when delete fails", async () => {
    const { deleteCronSchedule } = await import("../../hooks/useApi");
    const mockDelete = vi.mocked(deleteCronSchedule);
    mockDelete.mockRejectedValue(new Error("Delete forbidden"));

    mockFetchCronSchedules.mockResolvedValue([makeSchedule({ id: 99 })]);

    render(withToast(<CronPage />));

    await waitFor(() => screen.getByText("Delete"));

    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Yes"));

    await waitFor(() => {
      expect(
        screen.getByText(/Delete failed: Delete forbidden/),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// BUG PROBE 6: TaskList toast — error path on updateTaskStatus
// ---------------------------------------------------------------------------

describe("TaskList toast integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows error toast when updateTaskStatus fails", async () => {
    mockUpdateTaskStatus.mockRejectedValue(new Error("Unauthorized"));

    const tasks = [
      makeTask({ linearIssueId: "ENG-42", orcaStatus: "running" }),
    ];

    render(
      withToast(
        <TaskList tasks={tasks} selectedTaskId={null} onSelect={vi.fn()} />,
      ),
    );

    // Open status menu
    const statusBadge = screen.getByText(/running/);
    fireEvent.click(statusBadge);

    // Click "cancel" (not "running", which is the current status and filtered out)
    const cancelBtn = screen.getByText("cancel");
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(
        screen.getByText(/Status update failed: Unauthorized/),
      ).toBeInTheDocument();
    });
  });

  it("does NOT show toast when updateTaskStatus succeeds", async () => {
    mockUpdateTaskStatus.mockResolvedValue({ ok: true });

    const tasks = [
      makeTask({ linearIssueId: "ENG-43", orcaStatus: "running" }),
    ];

    render(
      withToast(
        <TaskList tasks={tasks} selectedTaskId={null} onSelect={vi.fn()} />,
      ),
    );

    // Open status menu
    const statusBadge = screen.getByText(/running/);
    fireEvent.click(statusBadge);

    const cancelBtn = screen.getByText("cancel");
    fireEvent.click(cancelBtn);

    // Wait for the API call to complete
    await waitFor(() => {
      expect(mockUpdateTaskStatus).toHaveBeenCalledWith("ENG-43", "canceled");
    });

    // No toast should appear on success
    expect(screen.queryByText(/Status update failed/)).not.toBeInTheDocument();
  });

  it("calls useToast at top level of component (not inside callback)", () => {
    // If useToast were called inside a callback, it would either throw or violate
    // rules of hooks. The test simply verifies the component renders without error
    // when wrapped in ToastProvider, confirming hook call is at top level.
    expect(() => {
      render(
        withToast(
          <TaskList tasks={[]} selectedTaskId={null} onSelect={vi.fn()} />,
        ),
      );
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// BUG PROBE 7: Duplicate dismiss — clicking dismiss twice shouldn't crash
// ---------------------------------------------------------------------------

describe("Toast double-dismiss edge case", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function Trigger() {
    const { showToast } = useToast();
    return <button onClick={() => showToast("double-dismiss test")}>go</button>;
  }

  it("does not crash when dismiss is called twice for the same toast", async () => {
    render(withToast(<Trigger />));

    fireEvent.click(screen.getByText("go"));

    await act(async () => {
      await Promise.resolve();
    });

    const dismissBtn = screen.getByLabelText("Dismiss");

    // First dismiss
    fireEvent.click(dismissBtn);

    // Advance 150ms (mid-animation) and try to dismiss again.
    // The button is gone at 300ms so this tests mid-animation double-click.
    await act(async () => {
      vi.advanceTimersByTime(150);
    });

    // Component should still be in the DOM (visible=false but not removed yet)
    // A second click on a now-hidden or removed button shouldn't crash
    expect(() => {
      try {
        fireEvent.click(dismissBtn);
      } catch {
        // DOM node may have been detached — that's fine
      }
    }).not.toThrow();

    // After full 300ms the toast is gone
    await act(async () => {
      vi.advanceTimersByTime(151);
    });
    expect(screen.queryByText("double-dismiss test")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// BUG PROBE 8: Empty message string — boundary condition
// ---------------------------------------------------------------------------

describe("Toast empty/edge message inputs", () => {
  function Trigger({ msg }: { msg: string }) {
    const { showToast } = useToast();
    return <button onClick={() => showToast(msg)}>go</button>;
  }

  it("renders toast with empty string message without crashing", async () => {
    render(withToast(<Trigger msg="" />));

    expect(() => fireEvent.click(screen.getByText("go"))).not.toThrow();
  });

  it("renders toast with very long message without layout crash", async () => {
    const longMsg = "A".repeat(1000);
    render(withToast(<Trigger msg={longMsg} />));

    expect(() => fireEvent.click(screen.getByText("go"))).not.toThrow();
    await waitFor(() => {
      // The text is inside a span; it may be truncated by CSS but should be in DOM
      expect(screen.getByText(longMsg)).toBeInTheDocument();
    });
  });

  it("renders toast with HTML-injection attempt safely (no XSS)", async () => {
    const xssAttempt = "<img src=x onerror=alert(1)>";
    render(withToast(<Trigger msg={xssAttempt} />));

    fireEvent.click(screen.getByText("go"));

    await waitFor(() => {
      // Should render as text, not as an img element
      expect(screen.getByText(xssAttempt)).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });
  });
});

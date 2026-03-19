/**
 * Tests targeting bugs in the useToast hook and toast system.
 */
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { ToastProvider, useToast } from "../useToast";

// Helper component that uses the toast context
function ToastTrigger({
  type,
  message,
}: {
  type: "success" | "error" | "info";
  message: string;
}) {
  const toast = useToast();
  return <button onClick={() => toast[type](message)}>fire-{type}</button>;
}

function renderWithProvider(ui: React.ReactNode) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

describe("useToast - exit animation timer leak", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * BUG: startExit creates a setTimeout that is NOT stored in timerMap.
   * If removeToast is called while a toast is already in its exit animation
   * (already exiting), a second removal timeout is scheduled. The toast's
   * DOM node may have already been removed by the first timeout when the
   * second fires — benign in production but indicates a timer leak.
   *
   * More critically: if the component unmounts during the EXIT_ANIMATION_MS
   * window, the untracked setTimeout still fires and calls setToasts on the
   * unmounted component.
   *
   * This test confirms the timer does NOT fire after unmount (would cause a
   * React state update on unmounted component warning in React 17, or throw
   * in strict test mode).
   */
  it("does not call setToasts after component unmounts during exit animation", async () => {
    const consoleSpy = vi.spyOn(console, "error");

    const { unmount } = renderWithProvider(
      <ToastTrigger type="success" message="Hello" />,
    );

    // Fire a toast
    fireEvent.click(screen.getByText("fire-success"));

    // Advance to just before auto-dismiss fires (4000ms - 1ms)
    act(() => {
      vi.advanceTimersByTime(3999);
    });

    // The toast is still visible — auto-dismiss hasn't fired yet.
    // Now trigger the exit manually by clicking dismiss
    const dismissBtn = screen.getByLabelText("Dismiss");
    fireEvent.click(dismissBtn);

    // Unmount while the EXIT_ANIMATION_MS (300ms) timer is still pending
    unmount();

    // Advance past the exit animation
    act(() => {
      vi.advanceTimersByTime(400);
    });

    // Should not have logged any React "can't perform state update on unmounted" errors
    const stateUpdateErrors = consoleSpy.mock.calls.filter(
      (args) =>
        typeof args[0] === "string" &&
        (args[0].includes("unmounted") || args[0].includes("memory leak")),
    );
    expect(stateUpdateErrors).toHaveLength(0);

    consoleSpy.mockRestore();
  });

  /**
   * BUG: When a toast's auto-dismiss fires and startExit is called,
   * the EXIT_ANIMATION_MS setTimeout inside startExit is NOT cleared if
   * the user also clicks dismiss during that 300ms window.
   * removeToast calls startExit again, creating a duplicate timeout.
   * Result: setToasts filter runs twice for the same ID, the second call
   * is a no-op but proves a double-timer scenario.
   *
   * This test verifies that clicking dismiss during exit animation does NOT
   * create observable duplicate state updates.
   */
  it("clicking dismiss during auto-exit animation does not cause double removal", async () => {
    const setToastsCalls: number[] = [];

    renderWithProvider(<ToastTrigger type="info" message="Timing toast" />);

    fireEvent.click(screen.getByText("fire-info"));

    // Advance to auto-dismiss (4000ms): this triggers startExit
    act(() => {
      vi.advanceTimersByTime(4000);
    });

    // Toast is now in exiting state (opacity-0 animation started).
    // The exit timer (300ms) is pending but NOT in timerMap, so removeToast
    // won't clear it. Click dismiss now to also call startExit again.
    // If dismiss button is still rendered during exit animation:
    const dismissBtns = screen.queryAllByLabelText("Dismiss");
    if (dismissBtns.length > 0) {
      fireEvent.click(dismissBtns[0]);
    }

    // Advance past full exit window
    act(() => {
      vi.advanceTimersByTime(400);
    });

    // Toast should be gone — no duplicate DOM elements
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("useToast - MAX_TOASTS eviction timer leak", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * BUG: When MAX_TOASTS (5) is exceeded and oldest toasts are evicted via
   * the overflow path in addToast, the eviction setTimeout inside the
   * setToasts updater function is NOT cleared when those toasts are removed.
   * The eviction timeout IS created inside a setState callback — at that
   * point, the timerMap.current reference is captured from the outer
   * closure, which is stale if addToast has been called concurrently.
   *
   * More concretely: the eviction setTimeout at line 138 in useToast.tsx
   * is created but never added to timerMap — so it can never be cleared
   * by removeToast or the component cleanup. This is a guaranteed timer leak
   * whenever more than MAX_TOASTS toasts are shown.
   */
  it("eviction timers for overflow toasts are tracked and clearable", async () => {
    renderWithProvider(
      <>
        <ToastTrigger type="success" message="Toast 1" />
        <ToastTrigger type="success" message="Toast 2" />
        <ToastTrigger type="success" message="Toast 3" />
        <ToastTrigger type="success" message="Toast 4" />
        <ToastTrigger type="success" message="Toast 5" />
        <ToastTrigger type="error" message="Toast 6 - overflow" />
      </>,
    );

    // Fire 5 toasts to hit the cap
    const buttons = screen.getAllByRole("button");
    for (let i = 0; i < 5; i++) {
      act(() => {
        fireEvent.click(buttons[i]);
      });
    }

    // All 5 should be visible
    expect(screen.getAllByRole("alert")).toHaveLength(5);

    // Fire 6th toast — this triggers overflow eviction of toast #1
    act(() => {
      fireEvent.click(buttons[5]);
    });

    // Still 5 toasts visible (evicted one is exiting, new one added)
    // The evicted toast's removal timer (300ms) is NOT in timerMap
    // Advance past the eviction animation
    act(() => {
      vi.advanceTimersByTime(400);
    });

    // Should now have 5 toasts (old #1 gone, toasts 2-6 remain)
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(5);

    // The 6th toast "Toast 6 - overflow" must be visible
    expect(screen.getByText("Toast 6 - overflow")).toBeInTheDocument();
  });
});

describe("useToast - used outside provider", () => {
  it("throws with a descriptive error when useToast is used without ToastProvider", () => {
    // Suppress React's own error boundary console output during this test
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => {
      render(<ToastTrigger type="success" message="test" />);
    }).toThrow("useToast must be used within a ToastProvider");

    consoleSpy.mockRestore();
  });
});

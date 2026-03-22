/**
 * Tests targeting bugs in CronPage's toast feedback behavior.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import CronPage from "../CronPage";
import type { CronSchedule } from "../../types";
import {
  fetchCronSchedules,
  deleteCronSchedule,
  updateCronSchedule,
  createCronSchedule,
} from "../../hooks/useApi";

vi.mock("../../hooks/useApi", () => ({
  fetchCronSchedules: vi.fn(),
  createCronSchedule: vi.fn(),
  updateCronSchedule: vi.fn(),
  deleteCronSchedule: vi.fn(),
  triggerCron: vi.fn().mockResolvedValue({ ok: true }),
  fetchCronRuns: vi.fn().mockResolvedValue([]),
  fetchCronTasks: vi.fn().mockResolvedValue([]),
}));

const mockFetchCronSchedules = vi.mocked(fetchCronSchedules);
const mockDeleteCronSchedule = vi.mocked(deleteCronSchedule);
const mockUpdateCronSchedule = vi.mocked(updateCronSchedule);
const mockCreateCronSchedule = vi.mocked(createCronSchedule);

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

describe("CronPage - delete success toast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * BUG: handleDelete in CronPage calls deleteCronSchedule, updates local
   * state, and clears deletingId — but NEVER calls onToast?.success().
   * Contrast this with handleCreate ("Schedule created") and
   * handleToggleEnabled ("Schedule enabled/disabled") which both fire success
   * toasts. Delete succeeding silently is inconsistent and was listed as a
   * requirement ("success toast for mutations").
   */
  it("fires a success toast when a schedule is deleted successfully", async () => {
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ id: 5, name: "Delete me" }),
    ]);
    mockDeleteCronSchedule.mockResolvedValue({ ok: true });

    const onToast = {
      success: vi.fn(),
      error: vi.fn(),
    };

    render(<CronPage onToast={onToast} />);

    await waitFor(() => {
      expect(screen.getByText("Delete me")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Yes"));

    await waitFor(() => {
      expect(mockDeleteCronSchedule).toHaveBeenCalledWith(5);
    });

    // The schedule should be removed
    await waitFor(() => {
      expect(screen.queryByText("Delete me")).not.toBeInTheDocument();
    });

    // BUG: this assertion fails because handleDelete never calls onToast.success
    expect(onToast.success).toHaveBeenCalledWith(
      expect.stringMatching(/deleted|removed|Schedule/i),
    );
  });

  /**
   * BUG: handleToggleEnabled does not have any loading state guard.
   * Clicking the toggle button rapidly fires multiple concurrent
   * updateCronSchedule calls. There is no `togglingId` state or disabled
   * attribute on the toggle button during the async operation.
   *
   * This test verifies that rapid double-click only calls updateCronSchedule
   * once. Currently it will call it twice.
   */
  it("does not call updateCronSchedule twice when toggle is clicked rapidly", async () => {
    const schedule = makeSchedule({ id: 1, enabled: 1 });
    const updated = makeSchedule({ id: 1, enabled: 0 });

    // Make the update slow to ensure overlap
    mockFetchCronSchedules.mockResolvedValue([schedule]);
    mockUpdateCronSchedule.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(updated), 100)),
    );

    const onToast = { success: vi.fn(), error: vi.fn() };
    render(<CronPage onToast={onToast} />);

    await waitFor(() => {
      expect(screen.getByTitle("Disable")).toBeInTheDocument();
    });

    const toggleBtn = screen.getByTitle("Disable");

    // Rapid double-click
    fireEvent.click(toggleBtn);
    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(mockUpdateCronSchedule).toHaveBeenCalled();
    });

    // BUG: This fails — updateCronSchedule is called twice (no guard)
    expect(mockUpdateCronSchedule).toHaveBeenCalledTimes(1);
  });

  /**
   * BUG: handleUpdate (for editing an existing schedule) passes errors to
   * the CronForm's local inline error state only. It does NOT call
   * onToast?.error() for the failure case, unlike handleToggleEnabled which
   * does call onToast?.error(). This is an inconsistency — update failures
   * are not toasted.
   *
   * Note: handleUpdate itself has no try/catch; errors propagate to
   * CronForm.handleSubmit's catch which sets the form's local `error` state.
   * The parent CronPage never sees the error and never toasts it.
   */
  it("fires an error toast when updating a schedule fails", async () => {
    const schedule = makeSchedule({ id: 3, name: "Edit me" });
    mockFetchCronSchedules.mockResolvedValue([schedule]);
    mockUpdateCronSchedule.mockRejectedValue(new Error("Update failed"));

    const onToast = { success: vi.fn(), error: vi.fn() };
    render(<CronPage onToast={onToast} />);

    await waitFor(() => {
      expect(screen.getByText("Edit me")).toBeInTheDocument();
    });

    // Open the edit form
    fireEvent.click(screen.getByText("Edit"));

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("e.g. Nightly sync"),
      ).toBeInTheDocument();
    });

    // Submit the form
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(mockUpdateCronSchedule).toHaveBeenCalled();
    });

    // BUG: this fails because handleUpdate doesn't call onToast.error
    expect(onToast.error).toHaveBeenCalledWith(
      expect.stringMatching(/Update failed/i),
    );
  });
});

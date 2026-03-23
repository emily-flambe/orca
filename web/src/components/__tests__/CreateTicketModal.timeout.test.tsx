/**
 * Adversarial tests specifically targeting the timeout fix for CreateTicketModal.
 * The bug being fixed was: "Create ticket modal hangs forever"
 * The fix: AbortSignal.timeout(30_000) in fetchJson
 *
 * These tests verify the timeout error surfaces correctly to the user.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import CreateTicketModal from "../CreateTicketModal";

vi.mock("../../hooks/useApi", () => ({
  fetchProjects: vi.fn().mockResolvedValue([]),
  createTask: vi.fn(),
}));

import { fetchProjects, createTask } from "../../hooks/useApi";

const mockFetchProjects = vi.mocked(fetchProjects);
const mockCreateTask = vi.mocked(createTask);

const defaultProps = {
  onClose: vi.fn(),
  onCreated: vi.fn(),
};

describe("CreateTicketModal - timeout error handling (the actual bug fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchProjects.mockResolvedValue([]);
  });

  // FAILING TEST: The existing tests don't cover this.
  // When createTask times out (throws "Request timed out"), the modal must:
  // 1. Display the error to the user
  // 2. Re-enable the submit button
  // 3. NOT stay stuck in "Creating..." state forever
  it("shows 'Request timed out' error and re-enables form when createTask times out", async () => {
    mockCreateTask.mockRejectedValue(new Error("Request timed out"));

    render(<CreateTicketModal {...defaultProps} />);

    const titleInput = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(titleInput, { target: { value: "My ticket" } });

    const form = screen
      .getByRole("button", { name: "Create ticket" })
      .closest("form")!;
    fireEvent.submit(form);

    // The button should show "Creating..." while in-flight
    await waitFor(() => {
      // After rejection, the error "Request timed out" must be visible
      expect(screen.getByText("Request timed out")).toBeInTheDocument();
    });

    // Critical: the button must NOT still say "Creating..." after timeout
    expect(
      screen.queryByRole("button", { name: "Creating..." }),
    ).not.toBeInTheDocument();

    // Critical: the submit button must be re-enabled (not stuck disabled)
    const submitButton = screen.getByRole("button", { name: "Create ticket" });
    expect(submitButton).not.toBeDisabled();
  });

  // FAILING TEST: Verify the original hang behavior is gone.
  // Before the fix, createTask returned a promise that never settled.
  // This test is a regression test - "Creating..." should NOT persist if the request times out.
  it("button does not stay stuck as 'Creating...' after timeout error", async () => {
    // Simulate: first the request hangs (never resolves), but our timeout should fire
    // In the mocked environment, we simulate the timeout completing
    mockCreateTask.mockRejectedValue(new Error("Request timed out"));

    render(<CreateTicketModal {...defaultProps} />);

    const titleInput = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(titleInput, { target: { value: "Timeout test" } });

    const form = screen
      .getByRole("button", { name: "Create ticket" })
      .closest("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      // After timeout error, "Creating..." MUST NOT remain
      expect(
        screen.queryByRole("button", { name: "Creating..." }),
      ).not.toBeInTheDocument();
    });

    // The form must be usable again (user can retry)
    const submitButton = screen.getByRole("button", { name: "Create ticket" });
    expect(submitButton).not.toBeDisabled();

    // The user should see a meaningful error, not silence
    expect(screen.getByText("Request timed out")).toBeInTheDocument();
  });

  // EDGE CASE: What if the error object is not an Error instance?
  // The handleSubmit has: err instanceof Error ? err.message : "Failed to create ticket"
  // If createTask throws a non-Error (string, object, null), does it show the fallback?
  it("shows fallback error message when a non-Error is thrown", async () => {
    // Throw a raw string instead of an Error object
    mockCreateTask.mockRejectedValue("raw string error");

    render(<CreateTicketModal {...defaultProps} />);

    const titleInput = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(titleInput, { target: { value: "Edge case ticket" } });

    const form = screen
      .getByRole("button", { name: "Create ticket" })
      .closest("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText("Failed to create ticket")).toBeInTheDocument();
    });
  });

  // EDGE CASE: What if fetchProjects times out?
  // The modal silently swallows fetchProjects errors (.catch(() => {}))
  // This means if projects fail to load (including timeout), the dropdown is empty
  // and the user doesn't know why. This is a UX bug - no error is shown.
  it("silently shows empty project dropdown if fetchProjects times out (UX gap)", async () => {
    mockFetchProjects.mockRejectedValue(new Error("Request timed out"));

    render(<CreateTicketModal {...defaultProps} />);

    // Wait for any async settling
    await new Promise((resolve) => setTimeout(resolve, 50));

    // No error shown to user for project load failure
    expect(screen.queryByText("Request timed out")).not.toBeInTheDocument();

    // Project select has no options (empty) but user doesn't know why
    // This is the documented gap - the fix only addressed createTask timeout,
    // not fetchProjects timeout UX
    const projectSelects = screen.getAllByRole("combobox");
    // The project select is the first combobox (empty, no options)
    const projectSelect = projectSelects[0]!;
    // With an empty projects list and no error shown, the user is confused
    expect(projectSelect).toBeInTheDocument();
    // No error indicator - this is the UX gap
    expect(screen.queryByText(/project/i)).toBeInTheDocument(); // just the label, no error
  });
});

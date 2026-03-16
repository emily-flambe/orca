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

describe("CreateTicketModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchProjects.mockResolvedValue([]);
  });

  it("renders the 'New ticket' heading", () => {
    render(<CreateTicketModal {...defaultProps} />);
    expect(screen.getByText("New ticket")).toBeInTheDocument();
  });

  it("renders title input, description textarea, priority select, status select", () => {
    render(<CreateTicketModal {...defaultProps} />);

    expect(
      screen.getByPlaceholderText("What needs to be done?"),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Markdown supported..."),
    ).toBeInTheDocument();
    // Priority select has "P4 – No priority" as default option
    expect(screen.getByDisplayValue("P4 – No priority")).toBeInTheDocument();
    // Status select has "Todo" as default option
    expect(screen.getByDisplayValue("Todo")).toBeInTheDocument();
  });

  it("Create ticket button is disabled when title is empty", () => {
    render(<CreateTicketModal {...defaultProps} />);

    const button = screen.getByRole("button", { name: "Create ticket" });
    expect(button).toBeDisabled();
  });

  it("Create ticket button is enabled when title is typed", () => {
    render(<CreateTicketModal {...defaultProps} />);

    const titleInput = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(titleInput, { target: { value: "My new ticket" } });

    const button = screen.getByRole("button", { name: "Create ticket" });
    expect(button).not.toBeDisabled();
  });

  it("successful submit: calls createTask with correct args and then calls onCreated with identifier", async () => {
    mockCreateTask.mockResolvedValue({
      identifier: "ENG-100",
      id: "uuid-123",
    });

    render(<CreateTicketModal {...defaultProps} />);

    const titleInput = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(titleInput, { target: { value: "Fix the bug" } });

    const form = screen
      .getByRole("button", { name: "Create ticket" })
      .closest("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Fix the bug",
          priority: 0,
          status: "todo",
        }),
      );
    });

    await waitFor(() => {
      expect(defaultProps.onCreated).toHaveBeenCalledWith("ENG-100");
    });
  });

  it("failed submit: shows error message", async () => {
    mockCreateTask.mockRejectedValue(
      new Error("Failed to create ticket in Linear"),
    );

    render(<CreateTicketModal {...defaultProps} />);

    const titleInput = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(titleInput, { target: { value: "My task" } });

    const form = screen
      .getByRole("button", { name: "Create ticket" })
      .closest("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(
        screen.getByText("Failed to create ticket in Linear"),
      ).toBeInTheDocument();
    });
  });

  it("cancel button calls onClose", () => {
    render(<CreateTicketModal {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("backdrop click calls onClose", () => {
    render(<CreateTicketModal {...defaultProps} />);

    const backdrop = screen.getByText("New ticket").closest(".fixed")!;
    fireEvent.click(backdrop);

    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape key calls onClose", () => {
    render(<CreateTicketModal {...defaultProps} />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("projects are populated in the select when fetchProjects returns data", async () => {
    mockFetchProjects.mockResolvedValue([
      { id: "proj-1", name: "Alpha Project" },
      { id: "proj-2", name: "Beta Project" },
    ]);

    render(<CreateTicketModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Alpha Project")).toBeInTheDocument();
      expect(screen.getByText("Beta Project")).toBeInTheDocument();
    });
  });

  it("button shows 'Creating...' while submitting", async () => {
    // Promise that never resolves — keeps submitting state
    mockCreateTask.mockReturnValue(new Promise(() => {}));

    render(<CreateTicketModal {...defaultProps} />);

    const titleInput = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(titleInput, { target: { value: "My task" } });

    const form = screen
      .getByRole("button", { name: "Create ticket" })
      .closest("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Creating..." }),
      ).toBeInTheDocument();
    });
  });

  it("trimmed title is passed to createTask (whitespace stripped)", async () => {
    mockCreateTask.mockResolvedValue({ identifier: "ENG-1", id: "uuid" });

    render(<CreateTicketModal {...defaultProps} />);

    const titleInput = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(titleInput, { target: { value: "  Trimmed title  " } });

    const form = screen
      .getByRole("button", { name: "Create ticket" })
      .closest("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Trimmed title" }),
      );
    });
  });

  it("description is not included in createTask args when empty", async () => {
    mockCreateTask.mockResolvedValue({ identifier: "ENG-1", id: "uuid" });

    render(<CreateTicketModal {...defaultProps} />);

    const titleInput = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(titleInput, { target: { value: "Title only" } });

    const form = screen
      .getByRole("button", { name: "Create ticket" })
      .closest("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      const callArgs = mockCreateTask.mock.calls[0]![0];
      expect(callArgs.description).toBeUndefined();
    });
  });
});

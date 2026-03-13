import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import CronPage from "../CronPage";
import type { CronSchedule } from "../../types";
import {
  fetchCronSchedules,
  createCronSchedule,
  updateCronSchedule,
  deleteCronSchedule,
} from "../../hooks/useApi";

vi.mock("../../hooks/useApi", () => ({
  fetchCronSchedules: vi.fn(),
  createCronSchedule: vi.fn(),
  updateCronSchedule: vi.fn(),
  deleteCronSchedule: vi.fn(),
}));

const mockFetchCronSchedules = vi.mocked(fetchCronSchedules);
const mockCreateCronSchedule = vi.mocked(createCronSchedule);
const mockUpdateCronSchedule = vi.mocked(updateCronSchedule);
const mockDeleteCronSchedule = vi.mocked(deleteCronSchedule);

function makeSchedule(overrides: Partial<CronSchedule> = {}): CronSchedule {
  return {
    id: 1,
    name: "Nightly sync",
    type: "claude",
    schedule: "0 2 * * *",
    prompt: "Run the nightly sync task",
    repoPath: null,
    model: null,
    maxTurns: null,
    timeoutMin: 60,
    maxRuns: null,
    runCount: 5,
    enabled: 1,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("CronPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state while fetchCronSchedules is pending", () => {
    mockFetchCronSchedules.mockReturnValue(new Promise(() => {}));
    render(<CronPage />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows error message if fetchCronSchedules rejects", async () => {
    mockFetchCronSchedules.mockRejectedValue(new Error("Network failure"));
    render(<CronPage />);
    await waitFor(() => {
      expect(screen.getByText(/Network failure/)).toBeInTheDocument();
    });
  });

  it("renders list of cron schedules with name, type badge, schedule, and prompt", async () => {
    const schedule = makeSchedule({
      name: "Daily report",
      type: "shell",
      schedule: "0 8 * * 1-5",
      prompt: "Generate daily report",
    });
    mockFetchCronSchedules.mockResolvedValue([schedule]);
    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByText("Daily report")).toBeInTheDocument();
    });
    expect(screen.getByText("shell")).toBeInTheDocument();
    expect(screen.getByText("0 8 * * 1-5")).toBeInTheDocument();
    expect(screen.getByText("Generate daily report")).toBeInTheDocument();
  });

  it("shows 'No cron schedules configured.' when list is empty", async () => {
    mockFetchCronSchedules.mockResolvedValue([]);
    render(<CronPage />);

    await waitFor(() => {
      expect(
        screen.getByText("No cron schedules configured."),
      ).toBeInTheDocument();
    });
  });

  it("'New schedule' button opens the create form", async () => {
    mockFetchCronSchedules.mockResolvedValue([]);
    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByText("No cron schedules configured.")).toBeInTheDocument();
    });

    const newBtn = screen.getByRole("button", { name: "New schedule" });
    fireEvent.click(newBtn);

    // Form should be visible — check for a Save button
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("enable/disable toggle calls updateCronSchedule with toggled enabled value", async () => {
    const schedule = makeSchedule({ id: 42, enabled: 1 });
    const updated = { ...schedule, enabled: 0 };
    mockFetchCronSchedules.mockResolvedValue([schedule]);
    mockUpdateCronSchedule.mockResolvedValue(updated as CronSchedule);

    render(<CronPage />);
    await waitFor(() => {
      expect(screen.getByText("Nightly sync")).toBeInTheDocument();
    });

    const toggleBtn = screen.getByTitle("Disable");
    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(mockUpdateCronSchedule).toHaveBeenCalledWith(42, { enabled: 0 });
    });
  });

  it("enable toggle calls updateCronSchedule with enabled: 1 when currently disabled", async () => {
    const schedule = makeSchedule({ id: 7, enabled: 0 });
    const updated = { ...schedule, enabled: 1 };
    mockFetchCronSchedules.mockResolvedValue([schedule]);
    mockUpdateCronSchedule.mockResolvedValue(updated as CronSchedule);

    render(<CronPage />);
    await waitFor(() => {
      expect(screen.getByText("Nightly sync")).toBeInTheDocument();
    });

    const toggleBtn = screen.getByTitle("Enable");
    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(mockUpdateCronSchedule).toHaveBeenCalledWith(7, { enabled: 1 });
    });
  });

  describe("delete button", () => {
    it("shows 'Confirm?' dialog after clicking Delete", async () => {
      mockFetchCronSchedules.mockResolvedValue([makeSchedule({ id: 10 })]);
      render(<CronPage />);

      await waitFor(() => {
        expect(screen.getByText("Nightly sync")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      expect(screen.getByText("Confirm?")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Yes" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "No" })).toBeInTheDocument();
    });

    it("clicking 'Yes' calls deleteCronSchedule and removes the item", async () => {
      mockFetchCronSchedules.mockResolvedValue([makeSchedule({ id: 10 })]);
      mockDeleteCronSchedule.mockResolvedValue({ ok: true });

      render(<CronPage />);
      await waitFor(() => {
        expect(screen.getByText("Nightly sync")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      fireEvent.click(screen.getByRole("button", { name: "Yes" }));

      await waitFor(() => {
        expect(mockDeleteCronSchedule).toHaveBeenCalledWith(10);
      });
      await waitFor(() => {
        expect(screen.queryByText("Nightly sync")).not.toBeInTheDocument();
      });
    });

    it("clicking 'No' cancels without calling deleteCronSchedule", async () => {
      mockFetchCronSchedules.mockResolvedValue([makeSchedule({ id: 10 })]);
      render(<CronPage />);

      await waitFor(() => {
        expect(screen.getByText("Nightly sync")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      expect(screen.getByText("Confirm?")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "No" }));

      expect(mockDeleteCronSchedule).not.toHaveBeenCalled();
      expect(screen.queryByText("Confirm?")).not.toBeInTheDocument();
      expect(screen.getByText("Nightly sync")).toBeInTheDocument();
    });
  });

  describe("edit button", () => {
    it("shows inline CronForm populated with schedule data", async () => {
      const schedule = makeSchedule({
        id: 5,
        name: "Weekly cleanup",
        schedule: "0 0 * * 0",
        prompt: "Clean up old files",
      });
      mockFetchCronSchedules.mockResolvedValue([schedule]);
      render(<CronPage />);

      await waitFor(() => {
        expect(screen.getByText("Weekly cleanup")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Edit" }));

      // Form fields should be populated
      const nameInput = screen.getByDisplayValue("Weekly cleanup");
      expect(nameInput).toBeInTheDocument();
      const scheduleInput = screen.getByDisplayValue("0 0 * * 0");
      expect(scheduleInput).toBeInTheDocument();
    });

    it("Cancel hides the edit form", async () => {
      mockFetchCronSchedules.mockResolvedValue([
        makeSchedule({ id: 5, name: "Weekly cleanup" }),
      ]);
      render(<CronPage />);

      await waitFor(() => {
        expect(screen.getByText("Weekly cleanup")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(
        screen.queryByRole("button", { name: "Save" }),
      ).not.toBeInTheDocument();
      // Schedule card should be visible again
      expect(screen.getByText("Weekly cleanup")).toBeInTheDocument();
    });
  });

  describe("CronForm validation", () => {
    it("submitting with empty name shows validation error", async () => {
      mockFetchCronSchedules.mockResolvedValue([]);
      render(<CronPage />);

      await waitFor(() => {
        expect(
          screen.getByText("No cron schedules configured."),
        ).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "New schedule" }));

      // Submit with all fields empty
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(
        screen.getByText("Name, schedule, and prompt are required."),
      ).toBeInTheDocument();
      expect(mockCreateCronSchedule).not.toHaveBeenCalled();
    });

    it("submitting with empty schedule shows validation error", async () => {
      mockFetchCronSchedules.mockResolvedValue([]);
      render(<CronPage />);

      await waitFor(() => {
        expect(
          screen.getByText("No cron schedules configured."),
        ).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "New schedule" }));

      // Fill name but leave schedule empty
      fireEvent.change(screen.getByPlaceholderText("e.g. Nightly sync"), {
        target: { value: "My schedule" },
      });
      fireEvent.change(screen.getByPlaceholderText("Describe the task..."), {
        target: { value: "Do something" },
      });
      // schedule stays empty
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(
        screen.getByText("Name, schedule, and prompt are required."),
      ).toBeInTheDocument();
      expect(mockCreateCronSchedule).not.toHaveBeenCalled();
    });

    it("successful create calls createCronSchedule with correct data, adds to list, hides form", async () => {
      mockFetchCronSchedules.mockResolvedValue([]);
      const newSchedule = makeSchedule({
        id: 99,
        name: "Test job",
        schedule: "*/5 * * * *",
        prompt: "Do a thing",
      });
      mockCreateCronSchedule.mockResolvedValue(newSchedule);

      render(<CronPage />);
      await waitFor(() => {
        expect(
          screen.getByText("No cron schedules configured."),
        ).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "New schedule" }));

      fireEvent.change(screen.getByPlaceholderText("e.g. Nightly sync"), {
        target: { value: "Test job" },
      });
      fireEvent.change(screen.getByPlaceholderText("0 2 * * *"), {
        target: { value: "*/5 * * * *" },
      });
      fireEvent.change(screen.getByPlaceholderText("Describe the task..."), {
        target: { value: "Do a thing" },
      });

      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockCreateCronSchedule).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "Test job",
            schedule: "*/5 * * * *",
            prompt: "Do a thing",
          }),
        );
      });

      // Item should appear in the list
      await waitFor(() => {
        expect(screen.getByText("Test job")).toBeInTheDocument();
      });

      // Form should be hidden
      expect(
        screen.queryByRole("button", { name: "Save" }),
      ).not.toBeInTheDocument();
    });
  });
});

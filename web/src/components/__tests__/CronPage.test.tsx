import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

function makeCronSchedule(overrides: Partial<CronSchedule> = {}): CronSchedule {
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
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("CronPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Schedule list rendering", () => {
    it("shows empty state when no schedules exist", async () => {
      mockFetchCronSchedules.mockResolvedValue([]);
      render(<CronPage />);

      await waitFor(() => {
        expect(
          screen.getByText("No cron schedules configured."),
        ).toBeInTheDocument();
      });
    });

    it("renders schedule name, cron expression, type badge, and run count", async () => {
      const schedule = makeCronSchedule({
        name: "Nightly sync",
        schedule: "0 2 * * *",
        type: "claude",
        runCount: 7,
      });
      mockFetchCronSchedules.mockResolvedValue([schedule]);
      render(<CronPage />);

      await waitFor(() => {
        expect(screen.getByText("Nightly sync")).toBeInTheDocument();
      });

      expect(screen.getByText("0 2 * * *")).toBeInTheDocument();
      expect(screen.getByText("claude")).toBeInTheDocument();
      expect(screen.getByText("Runs: 7")).toBeInTheDocument();
    });

    it("renders multiple schedules", async () => {
      const schedules = [
        makeCronSchedule({ id: 1, name: "Schedule One", type: "claude" }),
        makeCronSchedule({ id: 2, name: "Schedule Two", type: "shell" }),
      ];
      mockFetchCronSchedules.mockResolvedValue(schedules);
      render(<CronPage />);

      await waitFor(() => {
        expect(screen.getByText("Schedule One")).toBeInTheDocument();
      });
      expect(screen.getByText("Schedule Two")).toBeInTheDocument();
      expect(screen.getByText("shell")).toBeInTheDocument();
    });
  });

  describe("Create form validation", () => {
    it("shows form when New schedule button is clicked", async () => {
      const user = userEvent.setup();
      mockFetchCronSchedules.mockResolvedValue([]);
      render(<CronPage />);

      await waitFor(() => {
        expect(screen.getByText("New schedule")).toBeInTheDocument();
      });

      await user.click(screen.getByText("New schedule"));

      expect(screen.getByPlaceholderText("e.g. Nightly sync")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("0 2 * * *")).toBeInTheDocument();
    });

    it("shows validation error when submitting without required fields", async () => {
      const user = userEvent.setup();
      mockFetchCronSchedules.mockResolvedValue([]);
      render(<CronPage />);

      await waitFor(() => {
        expect(screen.getByText("New schedule")).toBeInTheDocument();
      });

      await user.click(screen.getByText("New schedule"));
      await user.click(screen.getByText("Save"));

      expect(
        screen.getByText("Name, schedule, and prompt are required."),
      ).toBeInTheDocument();
    });

    it("adds item to list on successful submit", async () => {
      const user = userEvent.setup();
      mockFetchCronSchedules.mockResolvedValue([]);
      const newSchedule = makeCronSchedule({
        id: 42,
        name: "My new schedule",
        schedule: "*/5 * * * *",
        prompt: "Do something useful",
      });
      mockCreateCronSchedule.mockResolvedValue(newSchedule);
      render(<CronPage />);

      await waitFor(() => {
        expect(screen.getByText("New schedule")).toBeInTheDocument();
      });

      await user.click(screen.getByText("New schedule"));

      await user.type(
        screen.getByPlaceholderText("e.g. Nightly sync"),
        "My new schedule",
      );
      await user.type(
        screen.getByPlaceholderText("0 2 * * *"),
        "*/5 * * * *",
      );
      await user.type(
        screen.getByPlaceholderText("Describe the task..."),
        "Do something useful",
      );

      await user.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(screen.getByText("My new schedule")).toBeInTheDocument();
      });

      expect(mockCreateCronSchedule).toHaveBeenCalledOnce();
    });
  });

  describe("Enable/disable toggle", () => {
    it("calls updateCronSchedule with flipped enabled value and updates list", async () => {
      const user = userEvent.setup();
      const schedule = makeCronSchedule({ id: 1, name: "Toggle me", enabled: 1 });
      const updatedSchedule = { ...schedule, enabled: 0 as const };
      mockFetchCronSchedules.mockResolvedValue([schedule]);
      mockUpdateCronSchedule.mockResolvedValue(updatedSchedule);
      render(<CronPage />);

      await waitFor(() => {
        expect(screen.getByText("Toggle me")).toBeInTheDocument();
      });

      const toggleButton = screen.getByTitle("Disable");
      await user.click(toggleButton);

      expect(mockUpdateCronSchedule).toHaveBeenCalledWith(1, { enabled: 0 });

      await waitFor(() => {
        expect(screen.getByTitle("Enable")).toBeInTheDocument();
      });
    });

    it("calls updateCronSchedule with enabled=1 when schedule is disabled", async () => {
      const user = userEvent.setup();
      const schedule = makeCronSchedule({ id: 1, name: "Disabled one", enabled: 0 });
      const updatedSchedule = { ...schedule, enabled: 1 as const };
      mockFetchCronSchedules.mockResolvedValue([schedule]);
      mockUpdateCronSchedule.mockResolvedValue(updatedSchedule);
      render(<CronPage />);

      await waitFor(() => {
        expect(screen.getByTitle("Enable")).toBeInTheDocument();
      });

      await user.click(screen.getByTitle("Enable"));

      expect(mockUpdateCronSchedule).toHaveBeenCalledWith(1, { enabled: 1 });

      await waitFor(() => {
        expect(screen.getByTitle("Disable")).toBeInTheDocument();
      });
    });
  });

  describe("Delete confirmation flow", () => {
    it("shows Confirm?/Yes/No after clicking Delete", async () => {
      const user = userEvent.setup();
      const schedule = makeCronSchedule({ id: 1, name: "To delete" });
      mockFetchCronSchedules.mockResolvedValue([schedule]);
      render(<CronPage />);

      await waitFor(() => {
        expect(screen.getByText("To delete")).toBeInTheDocument();
      });

      await user.click(screen.getByText("Delete"));

      expect(screen.getByText("Confirm?")).toBeInTheDocument();
      expect(screen.getByText("Yes")).toBeInTheDocument();
      expect(screen.getByText("No")).toBeInTheDocument();
    });

    it("dismisses confirmation when No is clicked", async () => {
      const user = userEvent.setup();
      const schedule = makeCronSchedule({ id: 1, name: "To delete" });
      mockFetchCronSchedules.mockResolvedValue([schedule]);
      render(<CronPage />);

      await waitFor(() => {
        expect(screen.getByText("To delete")).toBeInTheDocument();
      });

      await user.click(screen.getByText("Delete"));
      await user.click(screen.getByText("No"));

      expect(screen.queryByText("Confirm?")).not.toBeInTheDocument();
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });

    it("calls deleteCronSchedule and removes item when Yes is clicked", async () => {
      const user = userEvent.setup();
      const schedule = makeCronSchedule({ id: 1, name: "To delete" });
      mockFetchCronSchedules.mockResolvedValue([schedule]);
      mockDeleteCronSchedule.mockResolvedValue({ ok: true });
      render(<CronPage />);

      await waitFor(() => {
        expect(screen.getByText("To delete")).toBeInTheDocument();
      });

      await user.click(screen.getByText("Delete"));
      await user.click(screen.getByText("Yes"));

      expect(mockDeleteCronSchedule).toHaveBeenCalledWith(1);

      await waitFor(() => {
        expect(screen.queryByText("To delete")).not.toBeInTheDocument();
      });
    });
  });
});

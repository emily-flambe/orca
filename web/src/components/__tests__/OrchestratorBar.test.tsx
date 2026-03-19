import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import OrchestratorBar from "../OrchestratorBar";
import type { OrcaStatus } from "../../types";

function makeStatus(overrides: Partial<OrcaStatus> = {}): OrcaStatus {
  return {
    activeSessions: 0,
    activeTaskIds: [],
    queuedTasks: 0,
    costInWindow: 0,
    budgetLimit: 100,
    budgetWindowHours: 4,
    tokensInWindow: 0,
    tokenBudgetLimit: 100000,
    concurrencyCap: 2,
    implementModel: "sonnet",
    reviewModel: "haiku",
    fixModel: "sonnet",
    draining: false,
    drainSessionCount: 0,
    burnRatePerHour: null,
    tokensPerMinute: null,
    inputTokensInWindow: 0,
    outputTokensInWindow: 0,
    ...overrides,
  };
}

describe("OrchestratorBar - toast feedback", () => {
  let onConfigUpdate: ReturnType<typeof vi.fn>;
  let onToast: {
    success: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    onConfigUpdate = vi.fn().mockResolvedValue(undefined);
    onToast = { success: vi.fn(), error: vi.fn() };
  });

  it("fires success toast when concurrency cap is saved successfully", async () => {
    render(
      <OrchestratorBar
        status={makeStatus({ concurrencyCap: 2 })}
        onSync={vi.fn()}
        onConfigUpdate={onConfigUpdate}
        onNewTicket={vi.fn()}
        onToast={onToast}
      />,
    );

    // Click the concurrency cap button to enter edit mode
    const capButton = screen.getByTitle("Click to change max concurrency");
    fireEvent.click(capButton);

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(onConfigUpdate).toHaveBeenCalledWith({ concurrencyCap: 3 });
    });

    expect(onToast.success).toHaveBeenCalledWith("Concurrency cap updated");
    expect(onToast.error).not.toHaveBeenCalled();
  });

  it("fires error toast when concurrency cap update fails", async () => {
    onConfigUpdate.mockRejectedValue(new Error("Server error"));

    render(
      <OrchestratorBar
        status={makeStatus({ concurrencyCap: 2 })}
        onSync={vi.fn()}
        onConfigUpdate={onConfigUpdate}
        onNewTicket={vi.fn()}
        onToast={onToast}
      />,
    );

    const capButton = screen.getByTitle("Click to change max concurrency");
    fireEvent.click(capButton);

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(onToast.error).toHaveBeenCalledWith("Server error");
    });

    expect(onToast.success).not.toHaveBeenCalled();
  });

  it("fires success toast when token budget limit is saved successfully", async () => {
    render(
      <OrchestratorBar
        status={makeStatus({ tokenBudgetLimit: 100000 })}
        onSync={vi.fn()}
        onConfigUpdate={onConfigUpdate}
        onNewTicket={vi.fn()}
        onToast={onToast}
      />,
    );

    const limitButton = screen.getByTitle("Click to change token budget limit");
    fireEvent.click(limitButton);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "200000" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(onConfigUpdate).toHaveBeenCalledWith({ tokenBudgetLimit: 200000 });
    });

    expect(onToast.success).toHaveBeenCalledWith("Token budget limit updated");
    expect(onToast.error).not.toHaveBeenCalled();
  });

  it("fires error toast when token budget limit update fails", async () => {
    onConfigUpdate.mockRejectedValue(new Error("Budget error"));

    render(
      <OrchestratorBar
        status={makeStatus({ tokenBudgetLimit: 100000 })}
        onSync={vi.fn()}
        onConfigUpdate={onConfigUpdate}
        onNewTicket={vi.fn()}
        onToast={onToast}
      />,
    );

    const limitButton = screen.getByTitle("Click to change token budget limit");
    fireEvent.click(limitButton);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "200000" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(onToast.error).toHaveBeenCalledWith("Budget error");
    });

    expect(onToast.success).not.toHaveBeenCalled();
  });

  it("fires success toast when model is changed successfully", async () => {
    render(
      <OrchestratorBar
        status={makeStatus({ implementModel: "sonnet" })}
        onSync={vi.fn()}
        onConfigUpdate={onConfigUpdate}
        onNewTicket={vi.fn()}
        onToast={onToast}
      />,
    );

    // Find the implement model selector
    const selects = screen.getAllByRole("combobox");
    const implementSelect = selects[0]; // first is implement

    fireEvent.change(implementSelect, { target: { value: "haiku" } });

    await waitFor(() => {
      expect(onConfigUpdate).toHaveBeenCalledWith({ implementModel: "haiku" });
    });

    expect(onToast.success).toHaveBeenCalledWith(
      "implement model updated to haiku",
    );
    expect(onToast.error).not.toHaveBeenCalled();
  });

  it("fires error toast when model change fails", async () => {
    onConfigUpdate.mockRejectedValue(new Error("Model error"));

    render(
      <OrchestratorBar
        status={makeStatus({ reviewModel: "haiku" })}
        onSync={vi.fn()}
        onConfigUpdate={onConfigUpdate}
        onNewTicket={vi.fn()}
        onToast={onToast}
      />,
    );

    const selects = screen.getAllByRole("combobox");
    const reviewSelect = selects[1]; // second is review

    fireEvent.change(reviewSelect, { target: { value: "sonnet" } });

    await waitFor(() => {
      expect(onToast.error).toHaveBeenCalledWith("Model error");
    });

    expect(onToast.success).not.toHaveBeenCalled();
  });
});

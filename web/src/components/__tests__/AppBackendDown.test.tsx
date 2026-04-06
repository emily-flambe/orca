/**
 * Tests targeting the backendDown state logic in App.tsx.
 *
 * BUG: App.tsx sets backendDown=true if ANY of the three initial fetches fail
 * (fetchTasks, fetchStatus, fetchVersion). This means a failing /api/version
 * endpoint marks the backend as "down" even when tasks and status load fine.
 * The backend is not truly "unreachable" — just one endpoint errored.
 *
 * The failing condition is in the onFail handler:
 *   const onFail = () => { failed = true; setBackendDown(true); }
 * which triggers for any single fetch failure, including fetchVersion which
 * is not critical for the scheduler to be operational.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import App from "../../App";
import { ToastProvider } from "../../hooks/useToast";
import { fetchTasks, fetchStatus, fetchVersion } from "../../hooks/useApi";

vi.mock("../../hooks/useApi", () => ({
  fetchTasks: vi.fn(),
  fetchStatus: vi.fn(),
  fetchVersion: vi.fn(),
  fetchRunningInvocations: vi.fn().mockResolvedValue([]),
  triggerSync: vi.fn(),
  updateConfig: vi.fn(),
  fetchAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../hooks/useSSE", () => ({
  useSSE: vi.fn(),
}));

// Stub out heavy child components that make additional API calls
vi.mock("../../components/Sidebar", () => ({
  default: () => <div data-testid="sidebar" />,
}));
vi.mock("../../components/Header", () => ({
  default: () => <div data-testid="header" />,
}));

const mockFetchTasks = vi.mocked(fetchTasks);
const mockFetchStatus = vi.mocked(fetchStatus);
const mockFetchVersion = vi.mocked(fetchVersion);

const baseStatus = {
  activeSessions: 0,
  activeTaskIds: [],
  queuedTasks: 0,
  concurrencyCap: 1,
  model: "sonnet",
  draining: false,
  drainSessionCount: 0,
};

function renderApp() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <App />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe("App - backendDown state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT show backend-down banner when only fetchVersion fails but tasks and status succeed", async () => {
    // fetchTasks and fetchStatus succeed; only fetchVersion fails
    mockFetchTasks.mockResolvedValue([]);
    mockFetchStatus.mockResolvedValue(baseStatus);
    mockFetchVersion.mockRejectedValue(new Error("404 Not Found"));

    renderApp();

    // Wait for fetches to settle
    await waitFor(() => {
      expect(mockFetchTasks).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(mockFetchVersion).toHaveBeenCalled();
    });

    // Give React time to process state updates
    await new Promise((r) => setTimeout(r, 50));

    // BUG: This assertion fails because onFail sets backendDown=true even
    // when only fetchVersion (a non-critical endpoint) fails.
    expect(
      screen.queryByText(/Backend is unreachable/i),
    ).not.toBeInTheDocument();
  });

  it("shows backend-down banner when ALL fetches fail (genuine outage)", async () => {
    mockFetchTasks.mockRejectedValue(new Error("ECONNREFUSED"));
    mockFetchStatus.mockRejectedValue(new Error("ECONNREFUSED"));
    mockFetchVersion.mockRejectedValue(new Error("ECONNREFUSED"));

    renderApp();

    await waitFor(() => {
      expect(screen.getByText(/Backend is unreachable/i)).toBeInTheDocument();
    });
  });

  it("does NOT show backend-down banner when all fetches succeed", async () => {
    mockFetchTasks.mockResolvedValue([]);
    mockFetchStatus.mockResolvedValue(baseStatus);
    mockFetchVersion.mockResolvedValue({ version: "1.0.0" });

    renderApp();

    await waitFor(() => {
      expect(mockFetchTasks).toHaveBeenCalled();
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(
      screen.queryByText(/Backend is unreachable/i),
    ).not.toBeInTheDocument();
  });
});

import { useState, useEffect, useCallback } from "react";
import type { Task, OrcaStatus } from "./types";
import { fetchTasks, fetchStatus, triggerSync, updateConfig } from "./hooks/useApi";
import { useSSE } from "./hooks/useSSE";
import Sidebar from "./components/Sidebar";
import TaskList from "./components/TaskList";
import TaskDetail from "./components/TaskDetail";
import Metrics from "./components/Metrics";
import SystemLog from "./components/SystemLog";
import ActiveSessionsGrid from "./components/ActiveSessionsGrid";
import CreateTicketModal from "./components/CreateTicketModal";

type Page = "dashboard" | "tasks" | "logs" | "settings";

const MODEL_OPTIONS = ["opus", "sonnet", "haiku"] as const;

// SettingsPage: all controls from the old OrchestratorBar
interface SettingsPageProps {
  status: OrcaStatus | null;
  onSync: () => Promise<void>;
  onConfigUpdate: (config: {
    concurrencyCap?: number;
    implementModel?: string;
    reviewModel?: string;
    fixModel?: string;
  }) => Promise<void>;
}

function SettingsPage({ status, onSync, onConfigUpdate }: SettingsPageProps) {
  const [syncing, setSyncing] = useState(false);
  const [editingConcurrency, setEditingConcurrency] = useState(false);
  const [concurrencyInput, setConcurrencyInput] = useState("");

  const handleSync = async () => {
    setSyncing(true);
    try {
      await onSync();
    } finally {
      setSyncing(false);
    }
  };

  const startEditConcurrency = () => {
    if (!status) return;
    setConcurrencyInput(String(status.concurrencyCap));
    setEditingConcurrency(true);
  };

  const saveConcurrency = async () => {
    if (!status) return;
    const val = parseInt(concurrencyInput, 10);
    if (!Number.isNaN(val) && val >= 1 && val !== status.concurrencyCap) {
      await onConfigUpdate({ concurrencyCap: val });
    }
    setEditingConcurrency(false);
  };

  const handleConcurrencyKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      saveConcurrency();
    } else if (e.key === "Escape") {
      setEditingConcurrency(false);
    }
  };

  if (!status) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <h1 className="text-lg font-semibold text-gray-100 mb-6">Settings</h1>
        <p className="text-gray-500 text-sm">Loading...</p>
      </div>
    );
  }

  const pct =
    status.budgetLimit > 0
      ? Math.min((status.costInWindow / status.budgetLimit) * 100, 100)
      : 0;

  const barColor =
    pct < 50 ? "bg-green-500" : pct < 80 ? "bg-yellow-500" : "bg-red-500";

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="text-lg font-semibold text-gray-100 mb-6">Settings</h1>

      <div className="max-w-lg space-y-6">
        {/* Budget */}
        <section>
          <h2 className="text-sm font-medium text-gray-400 mb-3">Budget</h2>
          <div className="flex items-center gap-3">
            <div className="w-40 h-2 bg-gray-700 rounded-full overflow-hidden">
              <div
                className={`h-full ${barColor} rounded-full transition-all`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-gray-300 tabular-nums text-sm">
              ${status.costInWindow.toFixed(2)}
              <span className="text-gray-500"> / </span>$
              {status.budgetLimit.toFixed(2)}
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Window: {status.budgetWindowHours}h
          </p>
        </section>

        {/* Active sessions / concurrency */}
        <section>
          <h2 className="text-sm font-medium text-gray-400 mb-3">
            Sessions
          </h2>
          <div className="flex items-center gap-3 text-sm text-gray-300">
            {status.activeSessions > 0 && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
            )}
            <span>
              {status.activeSessions}
              <span className="text-gray-500"> / </span>
              {editingConcurrency ? (
                <input
                  type="number"
                  min="1"
                  value={concurrencyInput}
                  onChange={(e) => setConcurrencyInput(e.target.value)}
                  onBlur={saveConcurrency}
                  onKeyDown={handleConcurrencyKeyDown}
                  autoFocus
                  className="w-12 bg-gray-800 border border-gray-600 rounded px-1 text-center text-gray-200 text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
              ) : (
                <button
                  onClick={startEditConcurrency}
                  className="text-gray-300 hover:text-blue-400 cursor-pointer border-b border-dashed border-gray-600 hover:border-blue-400 transition-colors"
                  title="Click to change max concurrency"
                >
                  {status.concurrencyCap}
                </button>
              )}{" "}
              active
            </span>
          </div>
          <div className="mt-2 text-sm text-gray-400">
            Queued:{" "}
            <span className="text-gray-300">{status.queuedTasks}</span>
          </div>
        </section>

        {/* Models */}
        <section>
          <h2 className="text-sm font-medium text-gray-400 mb-3">Models</h2>
          <div className="space-y-3">
            {(["implement", "review", "fix"] as const).map((phase) => {
              const field =
                `${phase}Model` as
                  | "implementModel"
                  | "reviewModel"
                  | "fixModel";
              return (
                <label
                  key={phase}
                  className="flex items-center gap-3"
                >
                  <span className="text-gray-400 text-sm w-16">{phase}</span>
                  <select
                    value={status[field]}
                    onChange={(e) =>
                      onConfigUpdate({ [field]: e.target.value })
                    }
                    className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300 cursor-pointer hover:border-gray-500 transition-colors"
                  >
                    {MODEL_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>
        </section>

        {/* Sync */}
        <section>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="px-4 py-2 rounded bg-purple-600 text-purple-100 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
          >
            {syncing ? "Syncing..." : "Sync with Linear"}
          </button>
        </section>
      </div>
    </div>
  );
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [status, setStatus] = useState<OrcaStatus | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detailKey, setDetailKey] = useState(0);
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [activePage, setActivePage] = useState<Page>("tasks");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    fetchTasks().then(setTasks).catch(console.error);
    fetchStatus().then(setStatus).catch(console.error);
  }, []);

  const handleTaskUpdated = useCallback((task: unknown) => {
    const t = task as Task;
    setTasks((prev) =>
      prev.map((p) => (p.linearIssueId === t.linearIssueId ? t : p))
    );
  }, []);

  const handleStatusUpdated = useCallback((s: unknown) => {
    setStatus(s as OrcaStatus);
  }, []);

  const handleInvocationCompleted = useCallback(
    (data: { taskId: string }) => {
      if (data.taskId === selectedTaskId) {
        setDetailKey((k) => k + 1);
      }
    },
    [selectedTaskId]
  );

  const handleSync = useCallback(async () => {
    await triggerSync();
    const [newTasks, newStatus] = await Promise.all([
      fetchTasks(),
      fetchStatus(),
    ]);
    setTasks(newTasks);
    setStatus(newStatus);
  }, []);

  const handleConfigUpdate = useCallback(
    async (config: {
      concurrencyCap?: number;
      implementModel?: string;
      reviewModel?: string;
      fixModel?: string;
    }) => {
      await updateConfig(config);
      const newStatus = await fetchStatus();
      setStatus(newStatus);
    },
    []
  );

  const handleNewTicketCreated = useCallback(
    async (_identifier: string) => {
      setShowCreateModal(false);
      await handleSync();
    },
    [handleSync]
  );

  useSSE({
    onTaskUpdated: handleTaskUpdated,
    onStatusUpdated: handleStatusUpdated,
    onInvocationCompleted: handleInvocationCompleted,
  });

  const handleSelectTask = useCallback((id: string) => {
    setSelectedTaskId(id);
    setMobileView("detail");
  }, []);

  const handleNavigate = useCallback((page: Page) => {
    setActivePage(page);
    setSidebarOpen(false);
    if (page === "tasks") setMobileView("list");
  }, []);

  return (
    <div className="h-screen flex bg-gray-950 text-gray-100 overflow-hidden">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`fixed inset-y-0 left-0 z-50 md:relative md:z-auto transform transition-transform duration-200 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <Sidebar
          activePage={activePage}
          onNavigate={handleNavigate}
          activeSessions={status?.activeSessions ?? 0}
          tasks={tasks}
          onSync={handleSync}
          onNewTicket={() => setShowCreateModal(true)}
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        />
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile header */}
        <div className="md:hidden flex items-center px-4 py-3 border-b border-gray-800 shrink-0">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-gray-400 hover:text-gray-200 mr-3"
          >
            ☰
          </button>
          <span className="text-sm font-semibold text-gray-200">Orca</span>
        </div>

        {/* Dashboard */}
        {activePage === "dashboard" && (
          <div className="flex-1 overflow-y-auto">
            <div className="p-6">
              <h1 className="text-lg font-semibold text-gray-100 mb-4">
                Dashboard
              </h1>
            </div>
            <div className="px-6">
              <ActiveSessionsGrid />
            </div>
            <div className="px-6 mt-4">
              <Metrics />
            </div>
          </div>
        )}

        {/* Tasks */}
        {activePage === "tasks" && (
          <div className="flex flex-1 overflow-hidden">
            <div
              className={`flex-col border-r border-gray-800 overflow-y-auto ${
                mobileView === "detail" ? "hidden md:flex" : "flex"
              } w-full md:w-2/5`}
            >
              <TaskList
                tasks={tasks}
                selectedTaskId={selectedTaskId}
                onSelect={handleSelectTask}
              />
            </div>
            <div
              className={`flex-col overflow-y-auto ${
                mobileView === "list" ? "hidden md:flex" : "flex"
              } w-full md:w-3/5`}
            >
              <button
                onClick={() => setMobileView("list")}
                className="md:hidden flex items-center gap-2 px-4 py-3 text-sm text-gray-400 hover:text-gray-200 border-b border-gray-800 shrink-0 active:bg-gray-800"
              >
                ← Tasks
              </button>
              {selectedTaskId ? (
                <TaskDetail
                  key={`${selectedTaskId}-${detailKey}`}
                  taskId={selectedTaskId}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-gray-500">
                  Select a task to view details
                </div>
              )}
            </div>
          </div>
        )}

        {/* Logs */}
        {activePage === "logs" && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <SystemLog />
          </div>
        )}

        {/* Settings */}
        {activePage === "settings" && (
          <SettingsPage
            status={status}
            onSync={handleSync}
            onConfigUpdate={handleConfigUpdate}
          />
        )}
      </div>

      {showCreateModal && (
        <CreateTicketModal
          onClose={() => setShowCreateModal(false)}
          onCreated={handleNewTicketCreated}
        />
      )}
    </div>
  );
}

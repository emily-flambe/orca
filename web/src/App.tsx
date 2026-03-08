import { useState, useEffect, useCallback } from "react";
import type { Task, OrcaStatus } from "./types";
import { fetchTasks, fetchStatus, triggerSync, updateConfig } from "./hooks/useApi";
import { useSSE } from "./hooks/useSSE";
import Sidebar from "./components/Sidebar";
import type { Page } from "./components/Sidebar";
import TaskList from "./components/TaskList";
import TaskDetail from "./components/TaskDetail";
import SystemLog from "./components/SystemLog";
import ActiveSessionsGrid from "./components/ActiveSessionsGrid";
import Metrics from "./components/Metrics";

const MODEL_OPTIONS = ["opus", "sonnet", "haiku"] as const;

// ---------------------------------------------------------------------------
// Dashboard page
// ---------------------------------------------------------------------------

function DashboardPage({ status }: { status: OrcaStatus | null }) {
  return (
    <div className="flex-1 overflow-y-auto">
      {status && (
        <div className="px-4 pt-4 pb-2 flex gap-3 flex-wrap text-sm text-gray-400">
          <span>
            <span className="text-gray-500">Active: </span>
            <span className="text-gray-200">{status.activeSessions}</span>
            <span className="text-gray-500"> / </span>
            <span className="text-gray-200">{status.concurrencyCap}</span>
          </span>
          <span>
            <span className="text-gray-500">Queued: </span>
            <span className="text-gray-200">{status.queuedTasks}</span>
          </span>
        </div>
      )}
      <ActiveSessionsGrid />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

function SettingsPage({
  status,
  onConfigUpdate,
}: {
  status: OrcaStatus | null;
  onConfigUpdate: (config: {
    concurrencyCap?: number;
    implementModel?: string;
    reviewModel?: string;
    fixModel?: string;
  }) => Promise<void>;
}) {
  const [editingConcurrency, setEditingConcurrency] = useState(false);
  const [concurrencyInput, setConcurrencyInput] = useState("");

  if (!status) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
        Loading...
      </div>
    );
  }

  const pct =
    status.budgetLimit > 0
      ? Math.min((status.costInWindow / status.budgetLimit) * 100, 100)
      : 0;

  const barColor =
    pct < 50 ? "bg-green-500" : pct < 80 ? "bg-yellow-500" : "bg-red-500";

  const startEditConcurrency = () => {
    setConcurrencyInput(String(status.concurrencyCap));
    setEditingConcurrency(true);
  };

  const saveConcurrency = async () => {
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

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
        Settings
      </h2>

      {/* Budget card */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-2">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
          Budget
        </div>
        <div className="flex items-center gap-3">
          <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
            <div
              className={`h-full ${barColor} rounded-full transition-all`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-sm text-gray-300 tabular-nums whitespace-nowrap">
            ${status.costInWindow.toFixed(2)}
            <span className="text-gray-500"> / </span>$
            {status.budgetLimit.toFixed(2)}
          </span>
        </div>
        <div className="text-xs text-gray-500">
          Window: {status.budgetWindowHours}h
        </div>
      </div>

      {/* Concurrency card */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
          Concurrency
        </div>
        <div className="flex items-center gap-3">
          {status.activeSessions > 0 && (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
            </span>
          )}
          <span className="text-sm text-gray-300">
            {status.activeSessions} active
          </span>
          <span className="text-gray-600">·</span>
          <span className="text-sm text-gray-400">
            {status.queuedTasks} queued
          </span>
          <span className="text-gray-600">·</span>
          <span className="text-sm text-gray-400">
            Max:{" "}
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
            )}
          </span>
        </div>
      </div>

      {/* Model selectors card */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
        <div className="text-xs text-gray-500 uppercase tracking-wide">
          Models
        </div>
        {(["implement", "review", "fix"] as const).map((phase) => {
          const field =
            `${phase}Model` as "implementModel" | "reviewModel" | "fixModel";
          return (
            <div key={phase} className="flex items-center gap-3">
              <span className="text-sm text-gray-400 w-20 capitalize">
                {phase}
              </span>
              <select
                value={status[field]}
                onChange={(e) => onConfigUpdate({ [field]: e.target.value })}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-300 cursor-pointer hover:border-gray-500 transition-colors"
              >
                {MODEL_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tasks page
// ---------------------------------------------------------------------------

function TasksPage({
  tasks,
  selectedTaskId,
  mobileView,
  detailKey,
  onSelect,
  onMobileBack,
}: {
  tasks: Task[];
  selectedTaskId: string | null;
  mobileView: "list" | "detail";
  detailKey: number;
  onSelect: (id: string) => void;
  onMobileBack: () => void;
}) {
  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Task list */}
      <div
        className={`flex-col border-r border-gray-800 overflow-y-auto ${
          mobileView === "detail" ? "hidden md:flex" : "flex"
        } w-full md:w-2/5`}
      >
        <TaskList
          tasks={tasks}
          selectedTaskId={selectedTaskId}
          onSelect={onSelect}
        />
      </div>
      {/* Task detail */}
      <div
        className={`flex-col overflow-y-auto ${
          mobileView === "list" ? "hidden md:flex" : "flex"
        } w-full md:w-3/5`}
      >
        <button
          onClick={onMobileBack}
          className="md:hidden flex items-center gap-2 px-4 py-3 text-sm text-gray-400 hover:text-gray-200 border-b border-gray-800 shrink-0 active:bg-gray-800"
        >
          ← Tasks
        </button>
        {selectedTaskId ? (
          <TaskDetail key={`${selectedTaskId}-${detailKey}`} taskId={selectedTaskId} />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500">
            Select a task to view details
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [status, setStatus] = useState<OrcaStatus | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detailKey, setDetailKey] = useState(0);
  const [activePage, setActivePage] = useState<Page>("tasks");
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [sidebarOpen, setSidebarOpen] = useState(false);

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

  const handleNewTicket = useCallback(
    async (_identifier: string) => {
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

  const handleNavigate = useCallback(
    (page: Page) => {
      setActivePage(page);
      setSidebarOpen(false);
      if (page === "tasks") setMobileView("list");
    },
    []
  );

  return (
    <div className="h-screen flex bg-gray-950 text-gray-100">
      {/* Sidebar */}
      <Sidebar
        activePage={activePage}
        onNavigate={handleNavigate}
        status={status}
        tasks={tasks}
        onSync={handleSync}
        onNewTicket={handleNewTicket}
        isOpen={sidebarOpen}
      />

      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-10"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile hamburger header */}
        <div className="md:hidden flex items-center px-4 h-12 border-b border-gray-800 shrink-0 bg-gray-950">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-gray-400 hover:text-gray-200 transition-colors text-lg"
          >
            ☰
          </button>
          <span className="ml-3 text-sm font-bold tracking-widest uppercase text-gray-100">
            Orca
          </span>
        </div>

        {/* Page content */}
        {activePage === "tasks" && (
          <TasksPage
            tasks={tasks}
            selectedTaskId={selectedTaskId}
            mobileView={mobileView}
            detailKey={detailKey}
            onSelect={handleSelectTask}
            onMobileBack={() => setMobileView("list")}
          />
        )}

        {activePage === "dashboard" && (
          <DashboardPage status={status} />
        )}

        {activePage === "metrics" && (
          <div className="flex-1 overflow-y-auto">
            <Metrics />
          </div>
        )}

        {activePage === "logs" && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <SystemLog />
          </div>
        )}

        {activePage === "settings" && (
          <SettingsPage status={status} onConfigUpdate={handleConfigUpdate} />
        )}
      </div>
    </div>
  );
}

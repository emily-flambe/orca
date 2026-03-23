import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import type { Task, OrcaStatus } from "./types";
import {
  fetchTasks,
  fetchStatus,
  triggerSync,
  updateConfig,
  fetchVersion,
} from "./hooks/useApi";
import { useSSE } from "./hooks/useSSE";
import { useToast } from "./hooks/useToast";
import Sidebar from "./components/Sidebar";
import { formatTokens } from "./utils/formatTokens";
import type { Page } from "./components/Sidebar";
import Header from "./components/Header";
import TaskList from "./components/TaskList";
import TaskDetail from "./components/TaskDetail";
import SystemLog from "./components/SystemLog";
import ActiveSessionsGrid from "./components/ActiveSessionsGrid";
import CreateTicketModal from "./components/CreateTicketModal";
import CronPage from "./components/CronPage";
import AgentsPage from "./components/AgentsPage";
import MetricsPage from "./components/MetricsPage";
import LogsPage from "./components/LogsPage";
import HealthPage from "./components/HealthPage";
import PulsingDot from "./components/ui/PulsingDot";
import { MODEL_OPTIONS } from "./constants.js";

// ---------------------------------------------------------------------------
// StatusStrip — read-only status bar replacing OrchestratorBar
// ---------------------------------------------------------------------------

function StatusStrip({ status }: { status: OrcaStatus | null }) {
  if (!status) return null;
  const pct =
    status.tokenBudgetLimit > 0
      ? Math.min((status.tokensInWindow / status.tokenBudgetLimit) * 100, 100)
      : 0;
  const barColor =
    pct < 50 ? "bg-green-500" : pct < 80 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="shrink-0 flex items-center gap-4 px-4 py-1.5 border-b border-gray-800 bg-gray-900/50 text-xs text-gray-400">
      <span className="flex items-center gap-2">
        <span className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden inline-block align-middle">
          <span
            className={`block h-full ${barColor} rounded-full`}
            style={{ width: `${pct}%` }}
          />
        </span>
        <span className="tabular-nums">
          {formatTokens(status.tokensInWindow)} /{" "}
          {formatTokens(status.tokenBudgetLimit)}
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        {status.activeSessions > 0 && <PulsingDot color="blue" />}
        {status.activeSessions} active
      </span>
      <span>{status.queuedTasks} queued</span>
      <span className="text-gray-500">{status.model}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

function SettingsPage({
  status,
  onConfigUpdate,
  onSync,
  onNewTicket,
}: {
  status: OrcaStatus | null;
  onConfigUpdate: (config: {
    concurrencyCap?: number;
    agentConcurrencyCap?: number;
    tokenBudgetLimit?: number;
    model?: string;
    reviewModel?: string;
  }) => Promise<void>;
  onSync: () => Promise<void>;
  onNewTicket: (identifier: string) => Promise<void>;
}) {
  const [editingConcurrency, setEditingConcurrency] = useState(false);
  const [concurrencyInput, setConcurrencyInput] = useState("");
  const [editingAgentConcurrency, setEditingAgentConcurrency] = useState(false);
  const [agentConcurrencyInput, setAgentConcurrencyInput] = useState("");
  const [showCreateTicket, setShowCreateTicket] = useState(false);

  if (!status) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
        Loading...
      </div>
    );
  }

  const pct =
    status.tokenBudgetLimit > 0
      ? Math.min((status.tokensInWindow / status.tokenBudgetLimit) * 100, 100)
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

  const startEditAgentConcurrency = () => {
    setAgentConcurrencyInput(String(status.agentConcurrencyCap));
    setEditingAgentConcurrency(true);
  };

  const saveAgentConcurrency = async () => {
    const val = parseInt(agentConcurrencyInput, 10);
    if (!Number.isNaN(val) && val >= 1 && val !== status.agentConcurrencyCap) {
      await onConfigUpdate({ agentConcurrencyCap: val });
    }
    setEditingAgentConcurrency(false);
  };

  const handleAgentConcurrencyKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      saveAgentConcurrency();
    } else if (e.key === "Escape") {
      setEditingAgentConcurrency(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
        Settings
      </h2>

      {/* Token budget card */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-2">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
          Token Budget
        </div>
        <div className="flex items-center gap-3">
          <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
            <div
              className={`h-full ${barColor} rounded-full transition-all`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-sm text-gray-300 tabular-nums whitespace-nowrap">
            {formatTokens(status.tokensInWindow)}
            <span className="text-gray-500"> / </span>
            {formatTokens(status.tokenBudgetLimit)}
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
          {status.activeSessions > 0 && <PulsingDot color="blue" />}
          <span className="text-sm text-gray-300">
            {status.activeSessions} active
          </span>
          <span className="text-gray-600">&middot;</span>
          <span className="text-sm text-gray-400">
            {status.queuedTasks} queued
          </span>
          <span className="text-gray-600">&middot;</span>
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
          <span className="text-gray-600">&middot;</span>
          <span className="text-sm text-gray-400">
            Agent Max:{" "}
            {editingAgentConcurrency ? (
              <input
                type="number"
                min="1"
                value={agentConcurrencyInput}
                onChange={(e) => setAgentConcurrencyInput(e.target.value)}
                onBlur={saveAgentConcurrency}
                onKeyDown={handleAgentConcurrencyKeyDown}
                autoFocus
                className="w-12 bg-gray-800 border border-gray-600 rounded px-1 text-center text-gray-200 text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            ) : (
              <button
                onClick={startEditAgentConcurrency}
                className="text-gray-300 hover:text-blue-400 cursor-pointer border-b border-dashed border-gray-600 hover:border-blue-400 transition-colors"
                title="Click to change max agent concurrency"
              >
                {status.agentConcurrencyCap}
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
        {(["model", "review"] as const).map((phase) => {
          const field = phase === "model" ? "model" : "reviewModel";
          return (
            <div key={phase} className="flex items-center gap-3">
              <span className="text-sm text-gray-400 w-20 capitalize">
                {phase}
              </span>
              <select
                value={status[field]}
                onChange={(e) => {
                  const newModel = e.target.value;
                  if (
                    newModel === "opus" &&
                    !window.confirm(
                      "Switching to opus will significantly increase costs. Continue?",
                    )
                  )
                    return;
                  onConfigUpdate({ [field]: newModel });
                }}
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

      {/* Actions card */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
        <div className="text-xs text-gray-500 uppercase tracking-wide">
          Actions
        </div>
        <div className="flex gap-3">
          <button
            onClick={onSync}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-sm text-gray-300 transition-colors"
          >
            Sync with Linear
          </button>
          <button
            onClick={() => setShowCreateTicket(true)}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-sm text-gray-300 transition-colors"
          >
            New Ticket
          </button>
        </div>
      </div>

      {/* Debug logs */}
      <details className="bg-gray-900 border border-gray-800 rounded-lg">
        <summary className="px-4 py-3 text-xs text-gray-500 uppercase tracking-wide cursor-pointer hover:text-gray-400">
          Debug Logs
        </summary>
        <div className="border-t border-gray-800 h-96">
          <SystemLog />
        </div>
      </details>

      {/* Create ticket modal */}
      {showCreateTicket && (
        <CreateTicketModal
          onClose={() => setShowCreateTicket(false)}
          onCreated={(identifier) => {
            setShowCreateTicket(false);
            onNewTicket(identifier);
          }}
        />
      )}
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
  detailRefreshTrigger,
  invocationStartedTrigger,
  onSelect,
  onMobileBack,
  onToast,
}: {
  tasks: Task[];
  selectedTaskId: string | null;
  mobileView: "list" | "detail";
  detailKey: number;
  detailRefreshTrigger: number;
  invocationStartedTrigger: number;
  onSelect: (id: string) => void;
  onMobileBack: () => void;
  onToast: { success: (msg: string) => void; error: (msg: string) => void };
}) {
  return (
    <div className="flex flex-1 overflow-hidden flex-col min-h-0">
      {/* Active sessions grid */}
      <div className="shrink-0 max-h-[50%] overflow-y-auto">
        <ActiveSessionsGrid
          invocationStartedTrigger={invocationStartedTrigger}
        />
      </div>

      <div className="flex flex-1 overflow-hidden min-h-0">
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
            onToast={onToast}
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
            &larr; Tasks
          </button>
          {selectedTaskId ? (
            <TaskDetail
              key={`${selectedTaskId}-${detailKey}`}
              taskId={selectedTaskId}
              refreshTrigger={detailRefreshTrigger}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500">
              Select a task to view details
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();

  // Derive activePage from URL pathname
  const activePage = useMemo((): Page => {
    const path = location.pathname;
    if (path.startsWith("/tasks")) return "tasks";
    if (path === "/metrics") return "metrics";
    if (path === "/cron") return "cron";
    if (path === "/agents") return "agents";
    if (path === "/logs") return "logs";
    if (path === "/settings") return "settings";
    if (path === "/health") return "health";
    return "tasks"; // default to tasks, not dashboard
  }, [location.pathname]);

  // Derive selectedTaskId from URL pathname: /tasks/:id -> id segment
  const selectedTaskId = useMemo((): string | null => {
    const match = location.pathname.match(/^\/tasks\/(.+)$/);
    return match ? decodeURIComponent(match[1]!) : null;
  }, [location.pathname]);

  const toast = useToast();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [status, setStatus] = useState<OrcaStatus | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [backendDown, setBackendDown] = useState(false);
  const [detailKey, setDetailKey] = useState(0);
  const [detailRefreshTrigger, setDetailRefreshTrigger] = useState(0);
  const [invocationStartedTrigger, setInvocationStartedTrigger] = useState(0);
  const [mobileView, setMobileView] = useState<"list" | "detail">(
    selectedTaskId ? "detail" : "list",
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    let failCount = 0;
    const onFail = () => {
      failCount++;
    };
    Promise.all([
      fetchTasks().then(setTasks).catch(onFail),
      fetchStatus().then(setStatus).catch(onFail),
      fetchVersion()
        .then((v) => setVersion(v.version))
        .catch(onFail),
    ]).then(() => {
      // Only show banner when the two critical endpoints both fail (fetchVersion is cosmetic)
      setBackendDown(failCount >= 2);
    });
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        fetchTasks().then(setTasks).catch(console.error);
        fetchStatus().then(setStatus).catch(console.error);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  const handleTaskUpdated = useCallback(
    (task: unknown) => {
      const t = task as Task;
      setTasks((prev) => {
        const idx = prev.findIndex((p) => p.linearIssueId === t.linearIssueId);
        if (idx === -1) return [...prev, t];
        const next = [...prev];
        next[idx] = t;
        return next;
      });
      if (t.linearIssueId === selectedTaskId) {
        setDetailRefreshTrigger((n) => n + 1);
      }
    },
    [selectedTaskId],
  );

  const handleStatusUpdated = useCallback((s: unknown) => {
    setStatus(s as OrcaStatus);
  }, []);

  const handleInvocationStarted = useCallback(() => {
    setInvocationStartedTrigger((n) => n + 1);
  }, []);

  const handleInvocationCompleted = useCallback(
    (data: {
      taskId: string;
      invocationId: number;
      status: string;
      costUsd: number;
      inputTokens?: number;
      outputTokens?: number;
    }) => {
      if (data.taskId === selectedTaskId) {
        setDetailKey((k) => k + 1);
      }
    },
    [selectedTaskId],
  );

  const handleTasksRefreshed = useCallback(() => {
    fetchTasks().then(setTasks).catch(console.error);
  }, []);

  const handleReconnect = useCallback(() => {
    Promise.all([fetchTasks(), fetchStatus()])
      .then(([newTasks, newStatus]) => {
        setTasks(newTasks);
        setStatus(newStatus);
        setBackendDown(false);
      })
      .catch(console.error);
  }, []);

  const handleSync = useCallback(async () => {
    try {
      await triggerSync();
      const [newTasks, newStatus] = await Promise.all([
        fetchTasks(),
        fetchStatus(),
      ]);
      setTasks(newTasks);
      setStatus(newStatus);
      toast.success("Synced with Linear");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    }
  }, [toast]);

  const handleConfigUpdate = useCallback(
    async (config: {
      concurrencyCap?: number;
      agentConcurrencyCap?: number;
      tokenBudgetLimit?: number;
      model?: string;
      reviewModel?: string;
    }) => {
      try {
        await updateConfig(config);
        const newStatus = await fetchStatus();
        setStatus(newStatus);
        toast.success("Config updated");
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Config update failed",
        );
      }
    },
    [toast],
  );

  const handleNewTicket = useCallback(
    async (identifier: string) => {
      toast.success(`Ticket ${identifier} created`);
      await handleSync();
    },
    [handleSync, toast],
  );

  useSSE({
    onTaskUpdated: handleTaskUpdated,
    onStatusUpdated: handleStatusUpdated,
    onInvocationStarted: handleInvocationStarted,
    onInvocationCompleted: handleInvocationCompleted,
    onTasksRefreshed: handleTasksRefreshed,
    onReconnect: handleReconnect,
  });

  const handleSelectTask = useCallback(
    (id: string) => {
      navigate(`/tasks/${id}`);
      setMobileView("detail");
    },
    [navigate],
  );

  const handleNavigate = useCallback(
    (page: Page) => {
      const pathMap: Record<Page, string> = {
        tasks: "/tasks",
        metrics: "/metrics",
        cron: "/cron",
        agents: "/agents",
        logs: "/logs",
        settings: "/settings",
        health: "/health",
      };
      navigate(pathMap[page]);
      setSidebarOpen(false);
      if (page === "tasks") setMobileView("list");
    },
    [navigate],
  );

  return (
    <div className="h-screen flex bg-gray-950 text-gray-100">
      {/* Sidebar */}
      <Sidebar
        activePage={activePage}
        onNavigate={handleNavigate}
        status={status}
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
        <Header
          activePage={activePage}
          onOpenSidebar={() => setSidebarOpen(true)}
          status={status}
        />

        {/* Status strip — read-only status bar */}
        <StatusStrip status={status} />

        {/* Backend-down banner */}
        {backendDown && (
          <div className="shrink-0 bg-amber-900/50 border-b border-amber-700/60 px-4 py-2 text-sm text-amber-200 flex items-center gap-2">
            <PulsingDot color="amber" />
            Backend is unreachable — retrying...
          </div>
        )}

        {/* Page content */}
        {activePage === "tasks" && (
          <TasksPage
            tasks={tasks}
            selectedTaskId={selectedTaskId}
            mobileView={mobileView}
            detailKey={detailKey}
            detailRefreshTrigger={detailRefreshTrigger}
            invocationStartedTrigger={invocationStartedTrigger}
            onSelect={handleSelectTask}
            onMobileBack={() => {
              navigate("/tasks");
              setMobileView("list");
            }}
            onToast={toast}
          />
        )}

        {activePage === "metrics" && <MetricsPage />}

        {activePage === "settings" && (
          <SettingsPage
            status={status}
            onConfigUpdate={handleConfigUpdate}
            onSync={handleSync}
            onNewTicket={handleNewTicket}
          />
        )}

        {activePage === "cron" && <CronPage onToast={toast} />}

        {activePage === "agents" && <AgentsPage onToast={toast} />}

        {activePage === "logs" && <LogsPage />}

        {activePage === "health" && <HealthPage />}

        {/* Version footer */}
        {version && (
          <div className="shrink-0 flex justify-end px-4 py-1">
            <span className="text-xs text-gray-600">Orca v{version}</span>
          </div>
        )}
      </div>
    </div>
  );
}

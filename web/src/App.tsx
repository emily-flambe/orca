import { useState, useEffect, useCallback } from "react";
import type { Task, OrcaStatus } from "./types";
import { fetchTasks, fetchStatus, triggerSync, updateConfig } from "./hooks/useApi";
import { useSSE } from "./hooks/useSSE";
import Sidebar, { type Page } from "./components/Sidebar";
import TaskList from "./components/TaskList";
import TaskDetail from "./components/TaskDetail";
import Metrics from "./components/Metrics";
import SystemLog from "./components/SystemLog";
import ActiveSessionsGrid from "./components/ActiveSessionsGrid";
import SettingsPage from "./components/SettingsPage";

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
    [selectedTaskId],
  );

  const handleSync = useCallback(async () => {
    await triggerSync();
    const [newTasks, newStatus] = await Promise.all([fetchTasks(), fetchStatus()]);
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
    [],
  );

  const handleNewTicket = useCallback(
    async (_identifier: string) => {
      await handleSync();
    },
    [handleSync],
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

  return (
    <div className="h-screen flex bg-gray-950 text-gray-100 overflow-hidden">
      {/* Mobile hamburger */}
      {!sidebarOpen && (
        <button
          onClick={() => setSidebarOpen(true)}
          className="md:hidden fixed top-3 left-3 z-40 p-2 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors"
          aria-label="Open navigation"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      )}

      <Sidebar
        activePage={activePage}
        onNavigate={(page) => {
          setActivePage(page);
          if (page === "tasks") setMobileView("list");
        }}
        status={status}
        tasks={tasks}
        onSync={handleSync}
        onNewTicket={handleNewTicket}
        mobileOpen={sidebarOpen}
        onMobileClose={() => setSidebarOpen(false)}
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {activePage === "dashboard" && (
          <div className="flex-1 overflow-y-auto">
            <ActiveSessionsGrid />
            <Metrics />
          </div>
        )}

        {activePage === "tasks" && (
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
                onSelect={handleSelectTask}
              />
            </div>
            {/* Task detail */}
            <div
              className={`flex-col overflow-y-auto ${
                mobileView === "list" ? "hidden md:flex" : "flex"
              } w-full md:w-3/5`}
            >
              {/* Mobile back button */}
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

        {activePage === "logs" && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <SystemLog />
          </div>
        )}

        {activePage === "settings" && (
          <SettingsPage
            status={status}
            onConfigUpdate={handleConfigUpdate}
            onSync={handleSync}
          />
        )}
      </div>
    </div>
  );
}

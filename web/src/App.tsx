import { useState, useEffect, useCallback } from "react";
import type { Task, OrcaStatus } from "./types";
import { fetchTasks, fetchStatus, triggerSync, updateConfig } from "./hooks/useApi";
import { useSSE } from "./hooks/useSSE";
import OrchestratorBar from "./components/OrchestratorBar";
import TaskList from "./components/TaskList";
import TaskDetail from "./components/TaskDetail";
import Metrics from "./components/Metrics";
import SystemLog from "./components/SystemLog";
import ActiveSessionsGrid from "./components/ActiveSessionsGrid";

type Tab = "tasks" | "metrics" | "logs" | "sessions";

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [status, setStatus] = useState<OrcaStatus | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detailKey, setDetailKey] = useState(0);
  const [activeTab, setActiveTab] = useState<Tab>("tasks");
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");

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

  const handleConfigUpdate = useCallback(async (config: { concurrencyCap?: number; implementModel?: string; reviewModel?: string; fixModel?: string }) => {
    await updateConfig(config);
    const newStatus = await fetchStatus();
    setStatus(newStatus);
  }, []);

  const handleNewTicket = useCallback(async (_identifier: string) => {
    await handleSync();
  }, [handleSync]);

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
    <div className="h-screen flex flex-col bg-gray-950 text-gray-100">
      <OrchestratorBar status={status} onSync={handleSync} onConfigUpdate={handleConfigUpdate} onNewTicket={handleNewTicket} />

      {/* Tab bar */}
      <div className="flex gap-1 px-4 pt-2 border-b border-gray-800 bg-gray-950 shrink-0">
        {(["tasks", "sessions", "metrics", "logs"] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => {
              setActiveTab(tab);
              if (tab === "tasks") setMobileView("list");
            }}
            className={`px-4 py-1.5 text-sm rounded-t transition-colors ${
              activeTab === tab
                ? "bg-gray-800 text-gray-100 border border-b-gray-800 border-gray-700"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "tasks" && (
        <div className="flex flex-1 overflow-hidden">
          {/* Task list: full-screen on mobile (hidden when viewing detail), 2/5 on desktop */}
          <div className={`flex-col border-r border-gray-800 overflow-y-auto ${mobileView === "detail" ? "hidden md:flex" : "flex"} w-full md:w-2/5`}>
            <TaskList
              tasks={tasks}
              selectedTaskId={selectedTaskId}
              onSelect={handleSelectTask}
            />
          </div>
          {/* Task detail: full-screen on mobile (hidden in list view), 3/5 on desktop */}
          <div className={`flex-col overflow-y-auto ${mobileView === "list" ? "hidden md:flex" : "flex"} w-full md:w-3/5`}>
            {/* Mobile back button */}
            <button
              onClick={() => setMobileView("list")}
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
      )}

      {activeTab === "sessions" && (
        <div className="flex-1 overflow-y-auto">
          <ActiveSessionsGrid />
        </div>
      )}

      {activeTab === "metrics" && (
        <div className="flex-1 overflow-y-auto">
          <Metrics />
        </div>
      )}

      {activeTab === "logs" && (
        <div className="flex-1 overflow-hidden flex flex-col">
          <SystemLog />
        </div>
      )}
    </div>
  );
}

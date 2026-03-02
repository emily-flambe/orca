import { useState, useEffect, useCallback } from "react";
import type { Task, OrcaStatus } from "./types";
import { fetchTasks, fetchStatus, triggerSync, updateConfig } from "./hooks/useApi";
import { useSSE } from "./hooks/useSSE";
import OrchestratorBar from "./components/OrchestratorBar";
import TaskList from "./components/TaskList";
import TaskDetail from "./components/TaskDetail";
import MetricsView from "./components/MetricsView";

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [status, setStatus] = useState<OrcaStatus | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detailKey, setDetailKey] = useState(0);
  const [activeTab, setActiveTab] = useState<"tasks" | "metrics">("tasks");

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

  useSSE({
    onTaskUpdated: handleTaskUpdated,
    onStatusUpdated: handleStatusUpdated,
    onInvocationCompleted: handleInvocationCompleted,
  });

  return (
    <div className="h-screen flex flex-col bg-gray-950 text-gray-100">
      <OrchestratorBar status={status} onSync={handleSync} onConfigUpdate={handleConfigUpdate} />
      {/* Tab bar */}
      <div className="flex border-b border-gray-800 bg-gray-900 shrink-0">
        {(["tasks", "metrics"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm capitalize transition-colors ${
              activeTab === tab
                ? "text-white border-b-2 border-purple-500"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>
      {/* Tab content */}
      {activeTab === "tasks" ? (
        <div className="flex flex-1 overflow-hidden">
          <div className="w-2/5 border-r border-gray-800 overflow-y-auto">
            <TaskList
              tasks={tasks}
              selectedTaskId={selectedTaskId}
              onSelect={setSelectedTaskId}
            />
          </div>
          <div className="w-3/5 overflow-y-auto">
            {selectedTaskId ? (
              <TaskDetail key={`${selectedTaskId}-${detailKey}`} taskId={selectedTaskId} />
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500">
                Select a task to view details
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <MetricsView />
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback } from "react";
import type { Task, OrcaStatus } from "./types";
import { fetchTasks, fetchStatus, triggerSync, updateConfig } from "./hooks/useApi";
import { useSSE } from "./hooks/useSSE";
import OrchestratorBar from "./components/OrchestratorBar";
import TaskList from "./components/TaskList";
import TaskDetail from "./components/TaskDetail";

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [status, setStatus] = useState<OrcaStatus | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detailKey, setDetailKey] = useState(0);
  const [mobileShowDetail, setMobileShowDetail] = useState(false);

  const handleSelectTask = (id: string) => {
    setSelectedTaskId(id);
    setMobileShowDetail(true);
  };

  const handleBackToList = () => {
    setMobileShowDetail(false);
  };

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

  const handleConfigUpdate = useCallback(async (config: { concurrencyCap: number }) => {
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
      {/* Desktop layout */}
      <div className="hidden md:flex flex-1 overflow-hidden">
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
      {/* Mobile layout */}
      <div className="flex md:hidden flex-1 overflow-hidden">
        {!mobileShowDetail || !selectedTaskId ? (
          <div className="w-full overflow-y-auto">
            <TaskList
              tasks={tasks}
              selectedTaskId={selectedTaskId}
              onSelect={handleSelectTask}
            />
          </div>
        ) : (
          <div className="w-full overflow-y-auto flex flex-col">
            <div className="sticky top-0 z-10 bg-gray-950 border-b border-gray-800 px-3 py-2">
              <button
                onClick={handleBackToList}
                className="text-sm text-gray-400 hover:text-gray-200 active:text-gray-100 transition-colors flex items-center gap-1.5 min-h-[44px]"
              >
                &larr; Back to list
              </button>
            </div>
            <TaskDetail key={`${selectedTaskId}-${detailKey}`} taskId={selectedTaskId} />
          </div>
        )}
      </div>
    </div>
  );
}

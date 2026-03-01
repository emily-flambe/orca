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
      <div className="flex flex-1 overflow-hidden">
        {/* Task list: full width on mobile, 2/5 on desktop. Hidden on mobile when task selected */}
        <div className={`md:w-2/5 md:border-r border-gray-800 overflow-y-auto ${selectedTaskId ? 'hidden md:block' : 'w-full'}`}>
          <TaskList
            tasks={tasks}
            selectedTaskId={selectedTaskId}
            onSelect={setSelectedTaskId}
          />
        </div>
        {/* Task detail: full width on mobile, 3/5 on desktop. Hidden on mobile when no task */}
        <div className={`md:w-3/5 overflow-y-auto ${selectedTaskId ? 'w-full' : 'hidden md:block'}`}>
          {selectedTaskId ? (
            <TaskDetail key={`${selectedTaskId}-${detailKey}`} taskId={selectedTaskId} onBack={() => setSelectedTaskId(null)} />
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

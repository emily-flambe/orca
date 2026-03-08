import { useState, useEffect, useCallback } from "react";
import type { Invocation } from "../types";
import { fetchStatus, fetchTaskDetail } from "../hooks/useApi";
import { useSSE } from "../hooks/useSSE";
import LiveRunWidget from "./LiveRunWidget";

interface RunningInvocation {
  invocation: Invocation;
  taskId: string;
}

export default function ActiveSessionsGrid() {
  const [runningInvocations, setRunningInvocations] = useState<RunningInvocation[]>([]);
  const [costOverrides, setCostOverrides] = useState<Map<number, number | null>>(new Map());
  const [lastCompleted, setLastCompleted] = useState<{ taskId: string; costUsd: number | null } | null>(null);
  const [loading, setLoading] = useState(true);

  // On mount: fetch active task IDs from /api/status, then fetch each task's detail
  useEffect(() => {
    let cancelled = false;

    fetchStatus()
      .then(async (status) => {
        if (cancelled) return;
        const results = await Promise.allSettled(
          status.activeTaskIds.map((id) => fetchTaskDetail(id))
        );

        if (cancelled) return;

        const found: RunningInvocation[] = [];
        for (const result of results) {
          if (result.status !== "fulfilled") continue;
          const taskDetail = result.value;
          const running = taskDetail.invocations.filter((inv) => inv.status === "running");
          for (const inv of running) {
            found.push({ invocation: inv, taskId: taskDetail.linearIssueId });
          }
        }
        setRunningInvocations(found);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load active sessions:", err);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleInvocationStarted = useCallback(
    (data: { taskId: string; invocationId: number }) => {
      fetchTaskDetail(data.taskId)
        .then((taskDetail) => {
          const inv = taskDetail.invocations.find((i) => i.id === data.invocationId);
          if (inv) {
            setRunningInvocations((prev) => {
              if (prev.find((r) => r.invocation.id === inv.id)) return prev;
              return [...prev, { invocation: inv, taskId: data.taskId }];
            });
          }
        })
        .catch(console.error);
    },
    []
  );

  const handleInvocationCompleted = useCallback(
    (data: { taskId: string; invocationId: number; status: string; costUsd: number }) => {
      const cost = (data.costUsd as number | null) ?? null;
      setLastCompleted({ taskId: data.taskId, costUsd: cost });
      setCostOverrides((prev) => {
        const next = new Map(prev);
        next.set(data.invocationId, cost);
        return next;
      });
      setRunningInvocations((prev) =>
        prev.filter((r) => r.invocation.id !== data.invocationId)
      );
    },
    []
  );

  useSSE({
    onInvocationStarted: handleInvocationStarted,
    onInvocationCompleted: handleInvocationCompleted,
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12 text-gray-500 text-sm">
        Loading...
      </div>
    );
  }

  if (runningInvocations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-gray-500">
        <p className="text-lg mb-2">No active sessions</p>
        {lastCompleted && (
          <p className="text-sm">
            Last completed: {lastCompleted.taskId}
            {lastCompleted.costUsd != null
              ? ` · $${lastCompleted.costUsd.toFixed(2)}`
              : ""}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {runningInvocations.map(({ invocation }) => (
          <LiveRunWidget
            key={invocation.id}
            invocation={invocation}
            costUsd={costOverrides.get(invocation.id)}
            onAborted={() =>
              setRunningInvocations((prev) =>
                prev.filter((r) => r.invocation.id !== invocation.id)
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

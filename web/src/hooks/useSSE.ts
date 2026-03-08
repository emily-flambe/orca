import { useEffect, useRef } from "react";

export interface SSECallbacks {
  onTaskUpdated?: (task: unknown) => void;
  onInvocationStarted?: (data: { taskId: string; invocationId: number }) => void;
  onInvocationCompleted?: (data: { taskId: string; invocationId: number; status: string; costUsd: number }) => void;
  onStatusUpdated?: (status: unknown) => void;
  onTasksRefreshed?: () => void;
  onReconnect?: () => void;
}

export function useSSE(callbacks: SSECallbacks): void {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    const es = new EventSource("/api/events");
    let connected = false;

    es.onopen = () => {
      if (connected) {
        callbacksRef.current.onReconnect?.();
      }
      connected = true;
    };

    es.addEventListener("task:updated", (e) => {
      try {
        const data = JSON.parse(e.data);
        callbacksRef.current.onTaskUpdated?.(data);
      } catch { /* ignore parse errors */ }
    });

    es.addEventListener("invocation:started", (e) => {
      try {
        const data = JSON.parse(e.data);
        callbacksRef.current.onInvocationStarted?.(data);
      } catch { /* ignore */ }
    });

    es.addEventListener("invocation:completed", (e) => {
      try {
        const data = JSON.parse(e.data);
        callbacksRef.current.onInvocationCompleted?.(data);
      } catch { /* ignore */ }
    });

    es.addEventListener("status:updated", (e) => {
      try {
        const data = JSON.parse(e.data);
        callbacksRef.current.onStatusUpdated?.(data);
      } catch { /* ignore */ }
    });

    es.addEventListener("tasks:refreshed", () => {
      callbacksRef.current.onTasksRefreshed?.();
    });

    return () => {
      es.close();
    };
  }, []);
}

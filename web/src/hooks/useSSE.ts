import { useEffect, useRef } from "react";
import { useSSEContext } from "../contexts/SSEContext";

export interface SSECallbacks {
  onTaskUpdated?: (task: unknown) => void;
  onInvocationStarted?: (data: {
    taskId: string;
    invocationId: number;
  }) => void;
  onInvocationCompleted?: (data: {
    taskId: string;
    invocationId: number;
    status: string;
    costUsd: number;
    inputTokens?: number;
    outputTokens?: number;
  }) => void;
  onStatusUpdated?: (status: unknown) => void;
  onTasksRefreshed?: () => void;
  onReconnect?: () => void;
}

export function useSSE(callbacks: SSECallbacks): void {
  const ctx = useSSEContext();
  const callbacksRef = useRef<SSECallbacks>(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    if (!ctx) {
      // Fallback: create standalone connection (should not happen when SSEProvider is mounted)
      console.warn(
        "[useSSE] No SSEContext found — creating standalone EventSource",
      );
      const es = new EventSource("/api/events");
      let connected = false;
      es.onopen = () => {
        if (connected) callbacksRef.current.onReconnect?.();
        connected = true;
      };
      es.addEventListener("task:updated", (e) => {
        try {
          callbacksRef.current.onTaskUpdated?.(JSON.parse(e.data));
        } catch {
          /* ignore */
        }
      });
      es.addEventListener("invocation:started", (e) => {
        try {
          callbacksRef.current.onInvocationStarted?.(JSON.parse(e.data));
        } catch {
          /* ignore */
        }
      });
      es.addEventListener("invocation:completed", (e) => {
        try {
          callbacksRef.current.onInvocationCompleted?.(JSON.parse(e.data));
        } catch {
          /* ignore */
        }
      });
      es.addEventListener("status:updated", (e) => {
        try {
          callbacksRef.current.onStatusUpdated?.(JSON.parse(e.data));
        } catch {
          /* ignore */
        }
      });
      es.addEventListener("tasks:refreshed", () => {
        callbacksRef.current.onTasksRefreshed?.();
      });
      return () => es.close();
    }

    const id = Math.random().toString(36).slice(2);
    return ctx.subscribe(id, callbacksRef);
  }, [ctx]);
}

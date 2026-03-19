import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
  type RefObject,
} from "react";
import type { SSECallbacks } from "../hooks/useSSE";

interface SSEContextValue {
  subscribe: (id: string, callbacksRef: RefObject<SSECallbacks>) => () => void;
}

const SSEContext = createContext<SSEContextValue | null>(null);

export function useSSEContext(): SSEContextValue | null {
  return useContext(SSEContext);
}

export function SSEProvider({ children }: { children: ReactNode }) {
  const subscribersRef = useRef<Map<string, RefObject<SSECallbacks>>>(
    new Map(),
  );

  useEffect(() => {
    const es = new EventSource("/api/events");
    let connected = false;

    const dispatch = (fn: (cb: SSECallbacks) => void) => {
      subscribersRef.current.forEach((ref) => {
        if (ref.current) fn(ref.current);
      });
    };

    es.onopen = () => {
      if (connected) {
        dispatch((cb) => cb.onReconnect?.());
      }
      connected = true;
    };

    es.addEventListener("task:updated", (e) => {
      try {
        const data = JSON.parse(e.data);
        dispatch((cb) => cb.onTaskUpdated?.(data));
      } catch {
        /* ignore */
      }
    });

    es.addEventListener("invocation:started", (e) => {
      try {
        const data = JSON.parse(e.data);
        dispatch((cb) => cb.onInvocationStarted?.(data));
      } catch {
        /* ignore */
      }
    });

    es.addEventListener("invocation:completed", (e) => {
      try {
        const data = JSON.parse(e.data);
        dispatch((cb) => cb.onInvocationCompleted?.(data));
      } catch {
        /* ignore */
      }
    });

    es.addEventListener("status:updated", (e) => {
      try {
        const data = JSON.parse(e.data);
        dispatch((cb) => cb.onStatusUpdated?.(data));
      } catch {
        /* ignore */
      }
    });

    es.addEventListener("tasks:refreshed", () => {
      dispatch((cb) => cb.onTasksRefreshed?.());
    });

    return () => {
      es.close();
    };
  }, []);

  const subscribe = useCallback(
    (id: string, callbacksRef: RefObject<SSECallbacks>): (() => void) => {
      subscribersRef.current.set(id, callbacksRef);
      return () => {
        subscribersRef.current.delete(id);
      };
    },
    [],
  );

  return (
    <SSEContext.Provider value={{ subscribe }}>{children}</SSEContext.Provider>
  );
}

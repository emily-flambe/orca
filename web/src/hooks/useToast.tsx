import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Toast {
  id: string;
  type: "success" | "error" | "info";
  message: string;
  exiting: boolean;
}

interface ToastContextValue {
  success(msg: string): void;
  error(msg: string): void;
  info(msg: string): void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ToastContext = createContext<ToastContextValue | null>(null);

// ---------------------------------------------------------------------------
// Toast item component
// ---------------------------------------------------------------------------

function ToastItem({
  toast,
  onRemove,
}: {
  toast: Toast;
  onRemove: (id: string) => void;
}) {
  const colorMap = {
    success: "bg-green-900/90 border-green-700/60 text-green-100",
    error: "bg-red-900/90 border-red-700/60 text-red-100",
    info: "bg-gray-800/95 border-gray-700/60 text-gray-100",
  };

  const iconMap = {
    success: "✓",
    error: "✕",
    info: "i",
  };

  const iconColorMap = {
    success: "text-green-400",
    error: "text-red-400",
    info: "text-blue-400",
  };

  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 rounded-lg border shadow-lg max-w-sm w-full pointer-events-auto
        transition-all duration-300 ease-in-out
        ${colorMap[toast.type]}
        ${toast.exiting ? "opacity-0 translate-x-4" : "opacity-100 translate-x-0"}
      `}
      role="alert"
    >
      <span
        className={`shrink-0 text-xs font-bold w-4 h-4 flex items-center justify-center rounded-full border mt-0.5
          ${iconColorMap[toast.type]}
          ${toast.type === "success" ? "border-green-500" : toast.type === "error" ? "border-red-500" : "border-blue-500"}
        `}
      >
        {iconMap[toast.type]}
      </span>
      <span className="text-sm flex-1 leading-snug">{toast.message}</span>
      <button
        onClick={() => onRemove(toast.id)}
        className="shrink-0 text-gray-400 hover:text-gray-200 transition-colors text-sm leading-none"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const MAX_TOASTS = 5;
const AUTO_DISMISS_MS = 4000;
const EXIT_ANIMATION_MS = 300;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timerMap = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const startExit = useCallback((id: string) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)),
    );
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, EXIT_ANIMATION_MS);
  }, []);

  const addToast = useCallback(
    (type: "success" | "error" | "info", message: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      setToasts((prev) => {
        let next = [...prev, { id, type, message, exiting: false }];
        // If over cap, start exit on the oldest visible toasts
        if (next.length > MAX_TOASTS) {
          const excess = next.length - MAX_TOASTS;
          const toEvict = next.slice(0, excess).map((t) => t.id);
          toEvict.forEach((evictId) => {
            const existingTimer = timerMap.current.get(evictId);
            if (existingTimer) {
              clearTimeout(existingTimer);
              timerMap.current.delete(evictId);
            }
          });
          // Mark them as exiting
          next = next.map((t) =>
            toEvict.includes(t.id) ? { ...t, exiting: true } : t,
          );
          // Remove them after animation
          setTimeout(() => {
            setToasts((p) => p.filter((t) => !toEvict.includes(t.id)));
          }, EXIT_ANIMATION_MS);
        }
        return next;
      });

      // Auto-dismiss after delay
      const timer = setTimeout(() => {
        timerMap.current.delete(id);
        startExit(id);
      }, AUTO_DISMISS_MS);
      timerMap.current.set(id, timer);
    },
    [startExit],
  );

  const removeToast = useCallback(
    (id: string) => {
      const timer = timerMap.current.get(id);
      if (timer) {
        clearTimeout(timer);
        timerMap.current.delete(id);
      }
      startExit(id);
    },
    [startExit],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      success: (msg) => addToast("success", msg),
      error: (msg) => addToast("error", msg),
      info: (msg) => addToast("info", msg),
    }),
    [addToast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div
          className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 items-end pointer-events-none"
          aria-live="polite"
          aria-atomic="false"
        >
          {toasts.map((toast) => (
            <ToastItem key={toast.id} toast={toast} onRemove={removeToast} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}

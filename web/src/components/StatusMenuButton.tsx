import { useState, useEffect, useRef } from "react";
import { updateTaskStatus } from "../hooks/useApi";

const MANUAL_STATUSES = [
  { value: "backlog", label: "backlog", bg: "bg-gray-500/20 text-gray-500" },
  { value: "ready", label: "queued", bg: "bg-cyan-500/20 text-cyan-400" },
  { value: "done", label: "done", bg: "bg-green-500/20 text-green-400" },
] as const;

export function statusBadge(s: string): { bg: string; text: string } {
  switch (s) {
    case "done": return { bg: "bg-green-500/20 text-green-400", text: "done" };
    case "running": return { bg: "bg-blue-500/20 text-blue-400", text: "running" };
    case "ready": return { bg: "bg-cyan-500/20 text-cyan-400", text: "queued" };
    case "failed": return { bg: "bg-red-500/20 text-red-400", text: "failed" };
    case "dispatched": return { bg: "bg-gray-500/20 text-gray-400", text: "dispatched" };
    case "in_review": return { bg: "bg-purple-500/20 text-purple-400", text: "in review" };
    case "changes_requested": return { bg: "bg-orange-500/20 text-orange-400", text: "changes requested" };
    case "awaiting_ci": return { bg: "bg-yellow-500/20 text-yellow-400", text: "awaiting CI" };
    case "deploying": return { bg: "bg-teal-500/20 text-teal-400", text: "deploying" };
    case "backlog": return { bg: "bg-gray-500/20 text-gray-500", text: "backlog" };
    default: return { bg: "bg-gray-500/20 text-gray-400", text: s };
  }
}

interface Props {
  status: string;
  taskId: string;
  onStatusChange?: () => void;
  mobile?: boolean;
}

export default function StatusMenuButton({ status, taskId, onStatusChange, mobile }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const badge = statusBadge(status);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div className={`relative shrink-0 ${mobile ? "ml-auto" : ""}`} ref={ref}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className={`text-xs px-2 rounded-full cursor-pointer hover:opacity-80 transition-colors ${badge.bg} ${
          mobile ? "py-1.5 min-h-[44px] min-w-[44px] flex items-center justify-center" : "py-0.5"
        }`}
      >
        {badge.text} &#9662;
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-lg py-1 min-w-[120px]">
          {MANUAL_STATUSES.filter((s) => s.value !== status).map((s) => (
            <button
              key={s.value}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                updateTaskStatus(taskId, s.value)
                  .then(() => onStatusChange?.())
                  .catch(console.error);
              }}
              className={`w-full text-left px-3 text-xs hover:bg-gray-700 transition-colors ${s.bg} ${
                mobile ? "py-2.5 min-h-[44px]" : "py-1.5"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

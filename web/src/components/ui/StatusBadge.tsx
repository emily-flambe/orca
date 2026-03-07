import React from "react";

// Returns the CSS classes for a status value (bg + text color)
// statusStyles(s) is a pure helper exported for use in filter pills etc.
export function statusStyles(s: string): string {
  switch (s) {
    case "done": case "completed": return "bg-green-500/20 text-green-400";
    case "running": return "bg-blue-500/20 text-blue-400";
    case "ready": return "bg-cyan-500/20 text-cyan-400";
    case "failed": return "bg-red-500/20 text-red-400";
    case "dispatched": return "bg-gray-500/20 text-gray-400";
    case "in_review": return "bg-purple-500/20 text-purple-400";
    case "changes_requested": return "bg-orange-500/20 text-orange-400";
    case "awaiting_ci": return "bg-yellow-500/20 text-yellow-400";
    case "deploying": return "bg-teal-500/20 text-teal-400";
    case "backlog": return "bg-gray-500/20 text-gray-500";
    case "timed_out": return "bg-orange-500/20 text-orange-400";
    default: return "bg-gray-500/20 text-gray-400";
  }
}

// Human-readable label for a status value
export function statusLabel(s: string): string {
  switch (s) {
    case "ready": return "queued";
    case "in_review": return "in review";
    case "awaiting_ci": return "awaiting CI";
    case "changes_requested": return "changes requested";
    default: return s;
  }
}

interface Props {
  status: string;
  className?: string;
  children?: React.ReactNode;
}

// Renders a rounded pill badge for a task/invocation status
export default function StatusBadge({ status, className = "", children }: Props) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${statusStyles(status)} ${className}`}>
      {children ?? statusLabel(status)}
    </span>
  );
}

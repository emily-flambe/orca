export function getStatusBadgeClasses(status: string): string {
  switch (status) {
    // Queued
    case "backlog":
    case "ready":
      return "bg-cyan-500/20 text-cyan-400";
    // Working
    case "running":
    case "in_review":
    case "changes_requested":
    case "awaiting_ci":
    case "deploying":
      return "bg-blue-500/20 text-blue-400";
    // Done
    case "done":
    case "completed":
      return "bg-green-500/20 text-green-400";
    // Failed
    case "failed":
      return "bg-red-500/20 text-red-400";
    // Canceled
    case "canceled":
      return "bg-gray-500/20 text-gray-400";
    // Invocation statuses
    case "timed_out":
      return "bg-orange-500/20 text-orange-400";
    default:
      return "bg-gray-500/20 text-gray-400";
  }
}

export function getStatusDisplayText(status: string): string {
  switch (status) {
    case "backlog":
      return "queued";
    case "ready":
      return "queued";
    case "running":
      return "working";
    case "in_review":
      return "working (reviewing)";
    case "changes_requested":
      return "working (fixing)";
    case "awaiting_ci":
      return "working (CI)";
    case "deploying":
      return "working (deploying)";
    default:
      return status;
  }
}

interface Props {
  status: string;
  className?: string;
}

export default function StatusBadge({ status, className = "" }: Props) {
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full ${getStatusBadgeClasses(status)} ${className}`}
    >
      {getStatusDisplayText(status)}
    </span>
  );
}

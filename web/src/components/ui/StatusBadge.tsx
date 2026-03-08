export function getStatusBadgeClasses(status: string): string {
  switch (status) {
    case "done":
    case "completed":
      return "bg-green-500/20 text-green-400";
    case "running":
      return "bg-blue-500/20 text-blue-400";
    case "ready":
      return "bg-cyan-500/20 text-cyan-400";
    case "failed":
      return "bg-red-500/20 text-red-400";
    case "dispatched":
      return "bg-gray-500/20 text-gray-400";
    case "in_review":
      return "bg-purple-500/20 text-purple-400";
    case "changes_requested":
      return "bg-orange-500/20 text-orange-400";
    case "awaiting_ci":
      return "bg-yellow-500/20 text-yellow-400";
    case "deploying":
      return "bg-teal-500/20 text-teal-400";
    case "backlog":
      return "bg-gray-500/20 text-gray-500";
    case "timed_out":
      return "bg-orange-500/20 text-orange-400";
    default:
      return "bg-gray-500/20 text-gray-400";
  }
}

export function getStatusDisplayText(status: string): string {
  switch (status) {
    case "ready":
      return "queued";
    case "in_review":
      return "in review";
    case "changes_requested":
      return "changes requested";
    case "awaiting_ci":
      return "awaiting CI";
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

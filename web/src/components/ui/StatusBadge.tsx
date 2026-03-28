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

/** Color class based on lifecycle stage */
export function getStageBadgeClasses(stage: string): string {
  switch (stage) {
    case "backlog":
    case "ready":
      return "bg-cyan-500/20 text-cyan-400";
    case "active":
      return "bg-blue-500/20 text-blue-400";
    case "done":
      return "bg-green-500/20 text-green-400";
    case "failed":
      return "bg-red-500/20 text-red-400";
    case "canceled":
      return "bg-gray-500/20 text-gray-400";
    default:
      return "bg-gray-500/20 text-gray-400";
  }
}

/** Display text from lifecycle stage + phase */
export function getPhaseDisplayText(
  stage: string,
  phase: string | null | undefined,
): string {
  if (stage === "active" && phase) {
    switch (phase) {
      case "implement":
        return "implementing";
      case "review":
        return "reviewing";
      case "fix":
        return "fixing";
      case "ci":
        return "awaiting CI";
      case "deploy":
        return "deploying";
      default:
        return phase;
    }
  }
  switch (stage) {
    case "backlog":
      return "backlog";
    case "ready":
      return "queued";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return stage;
  }
}

interface Props {
  status: string;
  stage?: string;
  phase?: string | null;
  className?: string;
}

export default function StatusBadge({
  status,
  stage,
  phase,
  className = "",
}: Props) {
  const classes = stage
    ? getStageBadgeClasses(stage)
    : getStatusBadgeClasses(status);
  const text = stage
    ? getPhaseDisplayText(stage, phase)
    : getStatusDisplayText(status);
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full ${classes} ${className}`}
    >
      {text}
    </span>
  );
}

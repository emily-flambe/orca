/**
 * Returns Tailwind classes for a run-level status badge (success/failed/running/etc).
 * This is for invocation/run statuses, not task-level statuses (use StatusBadge.tsx for those).
 */
export function getRunStatusClasses(status: string): string {
  const colors: Record<string, string> = {
    // Lowercase variants (cron runs, invocations)
    success: "bg-green-900/40 text-green-400 border-green-700/40",
    failed: "bg-red-900/40 text-red-400 border-red-700/40",
    running: "bg-blue-900/40 text-blue-400 border-blue-700/40",
    // Uppercase variants (Inngest workflows)
    COMPLETED: "bg-green-900/40 text-green-400 border-green-700/40",
    FAILED: "bg-red-900/40 text-red-400 border-red-700/40",
    RUNNING: "bg-blue-900/40 text-blue-400 border-blue-700/40",
    QUEUED: "bg-gray-800 text-gray-400 border-gray-700",
    CANCELLED: "bg-yellow-900/40 text-yellow-400 border-yellow-700/40",
  };
  return colors[status] ?? "bg-gray-800 text-gray-400 border-gray-700";
}

export function runStatusBadge(status: string) {
  const cls = getRunStatusClasses(status);
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded-full border ${cls}`}>
      {status}
    </span>
  );
}

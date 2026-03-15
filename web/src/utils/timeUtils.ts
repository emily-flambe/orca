export function timeAgo(date: Date | string): string {
  const ms = Date.now() - (typeof date === "string" ? new Date(date) : date).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function formatUptime(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return `${d}d ${h}h`;
}

export function eventDotColor(type: string): string {
  switch (type) {
    case "startup":
    case "task_completed":
      return "bg-green-400";
    case "error":
    case "task_failed":
      return "bg-red-400";
    case "deploy":
      return "bg-blue-400";
    case "shutdown":
    case "health_check":
      return "bg-gray-500";
    case "restart":
      return "bg-yellow-400";
    default:
      return "bg-gray-500";
  }
}

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

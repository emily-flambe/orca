interface PriorityInfo { color: string; label: string; title: string; }

export function priorityInfo(p: number): PriorityInfo {
  switch (p) {
    case 1: return { color: "bg-red-500 text-white", label: "P0", title: "P0" };
    case 2: return { color: "bg-orange-500 text-white", label: "P1", title: "P1" };
    case 3: return { color: "bg-blue-500 text-white", label: "P2", title: "P2" };
    case 4: return { color: "bg-gray-500 text-white", label: "P3", title: "P3" };
    default: return { color: "bg-transparent border border-gray-600 text-gray-500", label: "P4", title: "P4" };
  }
}

interface Props { priority: number; }

export default function PriorityDot({ priority }: Props) {
  const info = priorityInfo(priority);
  return (
    <span
      title={info.title}
      className={`rounded-full shrink-0 flex items-center justify-center px-2 py-0.5 text-xs font-bold whitespace-nowrap ${info.color}`}
    >
      {info.label}
    </span>
  );
}

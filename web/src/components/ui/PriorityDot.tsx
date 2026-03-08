export function getPriorityDotClasses(p: number): string {
  switch (p) {
    case 1: return "bg-red-500 text-white";
    case 2: return "bg-orange-500 text-white";
    case 3: return "bg-blue-500 text-white";
    case 4: return "bg-gray-500 text-white";
    default: return "bg-transparent border border-gray-600 text-gray-500";
  }
}

export function getPriorityLabel(p: number): string {
  switch (p) {
    case 1: return "P0";
    case 2: return "P1";
    case 3: return "P2";
    case 4: return "P3";
    default: return "P4";
  }
}

interface Props {
  priority: number;
  className?: string;
}

export default function PriorityDot({ priority, className = "" }: Props) {
  return (
    <span
      className={`rounded-full shrink-0 flex items-center justify-center px-2 py-0.5 text-xs font-bold whitespace-nowrap ${getPriorityDotClasses(priority)} ${className}`}
    >
      {getPriorityLabel(priority)}
    </span>
  );
}

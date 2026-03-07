interface Props { className?: string; lines?: number; }

function SkeletonLine({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse bg-gray-800 rounded ${className}`} />;
}

export default function Skeleton({ lines = 3, className = "" }: Props) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonLine key={i} className={i === lines - 1 ? "h-3 w-2/3" : "h-3 w-full"} />
      ))}
    </div>
  );
}

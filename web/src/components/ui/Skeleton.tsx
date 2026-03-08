interface Props {
  className?: string;
  lines?: number;
}

export default function Skeleton({ className = "", lines }: Props) {
  if (lines && lines > 1) {
    return (
      <div className={`flex flex-col gap-2 ${className}`}>
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className={`animate-pulse bg-gray-800 rounded h-4 ${i === lines - 1 ? "w-2/3" : "w-full"}`}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`animate-pulse bg-gray-800 rounded h-4 w-full ${className}`}
    />
  );
}

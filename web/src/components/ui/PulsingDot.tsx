interface Props {
  color: "blue" | "amber";
  size?: "sm" | "md";
  className?: string;
}

const COLOR_MAP = {
  blue: { ping: "bg-blue-400", dot: "bg-blue-500" },
  amber: { ping: "bg-amber-400", dot: "bg-amber-500" },
} as const;

const SIZE_MAP = {
  sm: { outer: "h-2 w-2", inner: "h-2 w-2" },
  md: { outer: "h-2.5 w-2.5", inner: "h-2.5 w-2.5" },
} as const;

export default function PulsingDot({
  color,
  size = "sm",
  className = "",
}: Props) {
  const colors = COLOR_MAP[color];
  const sizes = SIZE_MAP[size];
  return (
    <span className={`relative flex ${sizes.outer} shrink-0 ${className}`}>
      <span
        className={`animate-ping absolute inline-flex h-full w-full rounded-full ${colors.ping} opacity-75`}
      />
      <span
        className={`relative inline-flex rounded-full ${sizes.inner} ${colors.dot}`}
      />
    </span>
  );
}

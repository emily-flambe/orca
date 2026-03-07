import { HTMLAttributes } from "react";

interface Props extends HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "count";
}

export default function Badge({ variant = "default", className = "", children, ...props }: Props) {
  const base = variant === "count"
    ? "text-[10px] tabular-nums leading-none"
    : "text-xs px-2 py-0.5 rounded-full bg-gray-700/60 text-gray-300 border border-gray-600";
  return (
    <span className={`${base} ${className}`} {...props}>
      {children}
    </span>
  );
}

import React from "react";

interface Props {
  children: React.ReactNode;
  variant?: "default" | "count";
  className?: string;
}

export default function Badge({
  children,
  variant = "default",
  className = "",
}: Props) {
  const variantClasses: Record<string, string> = {
    default:
      "bg-gray-700/60 text-gray-300 border border-gray-600 text-xs px-2 py-0.5 rounded-full",
    count: "text-[10px] tabular-nums leading-none opacity-60",
  };

  return (
    <span className={`${variantClasses[variant]} ${className}`}>
      {children}
    </span>
  );
}

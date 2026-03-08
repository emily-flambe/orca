import React from "react";

interface Props {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  children: React.ReactNode;
  className?: string;
  [key: string]: unknown;
}

export default function Button({
  variant = "secondary",
  size = "sm",
  children,
  className = "",
  ...rest
}: Props) {
  const variantClasses: Record<string, string> = {
    secondary: "bg-gray-800 text-gray-400 hover:text-gray-200",
    primary: "bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30",
    danger: "bg-red-500/20 text-red-400 hover:bg-red-500/30",
    ghost: "text-gray-500 hover:text-gray-300",
  };

  const sizeClasses: Record<string, string> = {
    sm: "text-xs px-2 py-0.5 rounded",
    md: "text-sm px-3 py-1.5 rounded",
  };

  return (
    <button
      className={`transition-colors ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

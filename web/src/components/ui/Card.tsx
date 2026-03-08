import React from "react";

interface Props {
  children: React.ReactNode;
  className?: string;
  padding?: boolean;
}

export default function Card({
  children,
  className = "",
  padding = true,
}: Props) {
  return (
    <div
      className={`bg-gray-900 border border-gray-800 rounded-lg ${padding ? "p-4" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

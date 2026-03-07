import { HTMLAttributes } from "react";

interface Props extends HTMLAttributes<HTMLDivElement> {
  padding?: boolean;
}

export default function Card({ padding = true, className = "", children, ...props }: Props) {
  return (
    <div
      className={`bg-gray-900 border border-gray-800 rounded-lg ${padding ? "p-4" : ""} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

import { ButtonHTMLAttributes } from "react";

type Variant = "default" | "danger" | "success" | "ghost";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
}

const VARIANT_CLASSES: Record<Variant, string> = {
  default: "bg-gray-800 text-gray-400 hover:text-gray-200",
  danger: "bg-red-500/20 text-red-400 hover:bg-red-500/30",
  success: "bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30",
  ghost: "text-gray-500 hover:text-gray-300",
};

const SIZE_CLASSES = {
  sm: "px-2 py-0.5 text-xs",
  md: "px-3 py-1.5 text-sm",
};

export default function Button({ variant = "default", size = "sm", className = "", children, ...props }: Props) {
  return (
    <button
      className={`rounded transition-colors ${SIZE_CLASSES[size]} ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

interface Props {
  message: string;
  subMessage?: string;
  className?: string;
}

export default function EmptyState({
  message,
  subMessage,
  className = "",
}: Props) {
  return (
    <div className={`p-4 text-center ${className}`}>
      <div className="text-sm text-gray-500">{message}</div>
      {subMessage && <div className="text-xs text-gray-600">{subMessage}</div>}
    </div>
  );
}

interface Props {
  message: string;
  icon?: string;
  className?: string;
}

export default function EmptyState({ message, icon, className = "" }: Props) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 py-8 text-center ${className}`}>
      {icon && <span className="text-2xl text-gray-600">{icon}</span>}
      <p className="text-sm text-gray-500">{message}</p>
    </div>
  );
}

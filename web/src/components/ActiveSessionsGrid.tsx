import { useState, useEffect, useCallback } from "react";
import type { Invocation } from "../types";
import { fetchRunningInvocations } from "../hooks/useApi";
import LiveRunWidget from "./LiveRunWidget";

interface Props {
  onTaskSelect?: (taskId: string) => void;
}

export default function ActiveSessionsGrid({ onTaskSelect: _onTaskSelect }: Props) {
  const [invocations, setInvocations] = useState<Invocation[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refetch = useCallback(() => {
    fetchRunningInvocations()
      .then((data) => { setInvocations(data); setLoaded(true); })
      .catch(console.error);
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    const es = new EventSource("/api/events");

    es.addEventListener("invocation:started", () => {
      refetch();
    });

    es.addEventListener("invocation:completed", () => {
      refetch();
    });

    return () => {
      es.close();
    };
  }, [refetch]);

  if (!loaded) {
    return null;
  }

  if (invocations.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        No active sessions
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
      {invocations.map((inv) => (
        <LiveRunWidget
          key={inv.id}
          invocation={inv}
          taskId={inv.linearIssueId}
          onCancel={refetch}
        />
      ))}
    </div>
  );
}

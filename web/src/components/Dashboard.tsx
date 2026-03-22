import { useState, useEffect } from "react";
import { fetchMetrics } from "../hooks/useApi";
import type { MetricsData } from "../hooks/useApi";
import { timeAgo } from "../utils/time.js";
import Card from "./ui/Card";
import Skeleton from "./ui/Skeleton";
import ActiveSessionsGrid from "./ActiveSessionsGrid";
import ActivityFeed from "./ActivityFeed";
import { useFetchWithPolling } from "../hooks/useFetchWithPolling.js";

// ---------------------------------------------------------------------------
// Main dashboard
// ---------------------------------------------------------------------------
interface DashboardProps {
  onNavigateToInvocation?: (
    linearIssueId: string,
    invocationId: number,
  ) => void;
  refreshTrigger?: number;
  invocationStartedTrigger?: number;
  lastCompletedEvent?: {
    taskId: string;
    invocationId: number;
    status: string;
    costUsd: number;
    inputTokens?: number;
    outputTokens?: number;
  } | null;
}

export default function Dashboard({
  onNavigateToInvocation,
  refreshTrigger,
  invocationStartedTrigger,
  lastCompletedEvent,
}: DashboardProps) {
  const { data, loading, error, reload } = useFetchWithPolling<MetricsData>({
    fetcher: fetchMetrics,
    intervalMs: 30_000,
  });
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Track last-updated time whenever data changes
  useEffect(() => {
    if (data) setLastUpdated(new Date());
  }, [data]);

  // Reload when parent signals a refresh
  useEffect(() => {
    if (refreshTrigger !== undefined && refreshTrigger > 0) {
      reload();
    }
  }, [refreshTrigger, reload]);

  if (loading) return <Skeleton lines={6} className="m-6" />;
  if (error)
    return <div className="p-6 text-sm text-red-400">Error: {error}</div>;
  if (!data) return null;

  const { recentActivity } = data;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Active sessions */}
      <ActiveSessionsGrid
        invocationStartedTrigger={invocationStartedTrigger}
        lastCompletedEvent={lastCompletedEvent}
      />

      {/* Activity feed */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs text-gray-500 uppercase tracking-wide">
            Recent Activity
          </div>
          {lastUpdated && (
            <div className="text-xs text-gray-600">
              Updated {timeAgo(lastUpdated)}
            </div>
          )}
        </div>
        <ActivityFeed
          entries={recentActivity}
          onNavigate={onNavigateToInvocation}
        />
      </Card>
    </div>
  );
}

import { useState, useEffect, useCallback } from "react";
import { fetchMetrics } from "../hooks/useApi";
import type { MetricsData } from "../hooks/useApi";
import { timeAgo } from "../utils/time.js";
import Card from "./ui/Card";
import Skeleton from "./ui/Skeleton";
import ActiveSessionsGrid from "./ActiveSessionsGrid";
import ActivityFeed from "./ActivityFeed";

// ---------------------------------------------------------------------------
// Main dashboard
// ---------------------------------------------------------------------------
interface DashboardProps {
  onNavigateToInvocation?: (
    linearIssueId: string,
    invocationId: number,
  ) => void;
  refreshTrigger?: number;
}

export default function Dashboard({
  onNavigateToInvocation,
  refreshTrigger,
}: DashboardProps) {
  const [data, setData] = useState<MetricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(() => {
    fetchMetrics()
      .then((d) => {
        setData(d);
        setError(null);
        setLastUpdated(new Date());
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (refreshTrigger !== undefined && refreshTrigger > 0) {
      load();
    }
  }, [refreshTrigger, load]);

  if (loading) return <Skeleton lines={6} className="m-6" />;
  if (error)
    return <div className="p-6 text-sm text-red-400">Error: {error}</div>;
  if (!data) return null;

  const { recentActivity } = data;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Active sessions */}
      <ActiveSessionsGrid />

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

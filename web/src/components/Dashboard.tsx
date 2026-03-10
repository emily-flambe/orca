import { useState, useEffect, useCallback } from "react";
import { fetchMetrics } from "../hooks/useApi";
import type { MetricsData } from "../hooks/useApi";
import Card from "./ui/Card";
import Button from "./ui/Button";
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
}

export default function Dashboard({ onNavigateToInvocation }: DashboardProps) {
  const [data, setData] = useState<MetricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchMetrics()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Skeleton lines={6} className="m-6" />;
  if (error)
    return <div className="p-6 text-sm text-red-400">Error: {error}</div>;
  if (!data) return null;

  const { recentActivity, successRate12h } = data;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
          Dashboard
        </h2>
        <Button variant="secondary" size="sm" onClick={load}>
          Refresh
        </Button>
      </div>

      {/* Success rate */}
      {successRate12h !== null && (
        <Card>
          <div className="text-xs text-gray-500 mb-1 uppercase tracking-wide">
            Success rate (past 12h)
          </div>
          <div className="text-2xl font-semibold text-gray-100 tabular-nums">
            {Math.round(successRate12h * 100)}%
          </div>
        </Card>
      )}

      {/* Active sessions */}
      <ActiveSessionsGrid />

      {/* Activity feed */}
      <Card>
        <div className="text-xs text-gray-500 mb-3 uppercase tracking-wide">
          Recent Activity
        </div>
        <ActivityFeed
          entries={recentActivity}
          onNavigate={onNavigateToInvocation}
        />
      </Card>
    </div>
  );
}

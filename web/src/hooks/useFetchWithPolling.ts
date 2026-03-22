import { useState, useEffect, useCallback } from "react";

interface UseFetchWithPollingOptions<T> {
  /** The async function to call for data. */
  fetcher: () => Promise<T>;
  /** Polling interval in milliseconds. Pass 0 or undefined to disable polling. */
  intervalMs?: number;
}

interface UseFetchWithPollingResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Manually trigger a reload. */
  reload: () => void;
}

export function useFetchWithPolling<T>({
  fetcher,
  intervalMs,
}: UseFetchWithPollingOptions<T>): UseFetchWithPollingResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetcher()
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoading(false));
  }, [fetcher]);

  useEffect(() => {
    load();
    if (intervalMs && intervalMs > 0) {
      const interval = setInterval(load, intervalMs);
      return () => clearInterval(interval);
    }
  }, [load, intervalMs]);

  return { data, loading, error, reload: load };
}

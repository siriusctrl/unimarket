import { useCallback, useEffect, useRef, useState } from "react";

import { type DashboardApiClient, type OverviewResponse } from "./dashboard-api";

export const useDashboardOverview = ({
  client,
}: {
  client: DashboardApiClient;
}) => {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  // Keep stale data visible if a refresh fails after the first successful load.
  const overviewRef = useRef(overview);
  overviewRef.current = overview;

  const fetchOverview = useCallback(
    async (): Promise<void> => {
      setLoading(true);

      try {
        const payload = await client.getOverview();
        setOverview(payload);
        setError(null);
      } catch (fetchError) {
        // Only show error if we have no data yet — otherwise keep stale data visible
        if (!overviewRef.current) {
          if (fetchError instanceof Error) {
            setError(fetchError.message);
          } else {
            setError("Unknown error while loading overview.");
          }
        }
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  // Fetch once on mount
  useEffect(() => {
    void fetchOverview();
  }, [fetchOverview]);

  return {
    overview,
    error,
    loading,
    refresh: fetchOverview,
  };
};

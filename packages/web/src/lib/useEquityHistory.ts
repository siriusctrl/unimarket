import { useCallback, useEffect, useRef, useState } from "react";

import { type DashboardApiClient, type EquityHistoryResponse } from "./dashboard-api";

export const useEquityHistory = ({
  client,
  range = "1m",
}: {
  client: DashboardApiClient;
  range?: string;
}) => {
  const [data, setData] = useState<EquityHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await client.getEquityHistory(range);
      setData(payload);
      setError(null);
    } catch (error) {
      if (!dataRef.current) {
        setError(error instanceof Error ? error.message : "Failed to load equity history");
      }
    } finally {
      setLoading(false);
    }
  }, [client, range]);

  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory]);

  return { data, loading, error, refresh: fetchHistory };
};

import { useCallback, useEffect, useState } from "react";

export type EquitySnapshot = {
    snapshotAt: string;
    equity: number;
    balance: number;
    marketValue: number;
    unrealizedPnl: number;
};

export type AgentSeries = {
    userId: string;
    userName: string;
    snapshots: EquitySnapshot[];
};

export type EquityHistoryResponse = {
    range: string;
    series: AgentSeries[];
};

export const useEquityHistory = ({
    adminKey,
    range = "1m",
}: {
    adminKey: string;
    range?: string;
}) => {
    const [data, setData] = useState<EquityHistoryResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchHistory = useCallback(async () => {
        if (!adminKey) return;
        setLoading(true);
        try {
            const response = await fetch(`/api/admin/equity-history?range=${range}`, {
                headers: { Authorization: `Bearer ${adminKey}` },
            });
            if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
            const payload = (await response.json()) as EquityHistoryResponse;
            setData(payload);
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to load equity history");
        } finally {
            setLoading(false);
        }
    }, [adminKey, range]);

    useEffect(() => {
        void fetchHistory();
    }, [fetchHistory]);

    return { data, loading, error, refresh: fetchHistory };
};

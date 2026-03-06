import { useCallback, useEffect, useRef, useState } from "react";

import { createAdminApiClient, isAdminAuthError, type EquityHistoryResponse } from "./admin-api";

export const useEquityHistory = ({
    adminKey,
    range = "1m",
    onAuthError,
}: {
    adminKey: string;
    range?: string;
    onAuthError?: () => void;
}) => {
    const [data, setData] = useState<EquityHistoryResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const onAuthErrorRef = useRef(onAuthError);

    onAuthErrorRef.current = onAuthError;

    const fetchHistory = useCallback(async () => {
        if (!adminKey) return;
        setLoading(true);
        try {
            const client = createAdminApiClient({
                adminKey,
                onAuthError: () => onAuthErrorRef.current?.(),
            });
            const payload = await client.getEquityHistory(range);
            setData(payload);
            setError(null);
        } catch (e) {
            if (isAdminAuthError(e)) {
                return;
            }
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

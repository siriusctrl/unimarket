import type { TimelineEventRecord } from "@unimarket/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { createAdminApiClient, isAdminAuthError } from "./admin-api";

export type TimelineEvent = TimelineEventRecord;

const PAGE_SIZE = 20;

export const useAgentTimeline = ({
    userId,
    adminKey,
    onAuthError,
}: {
    userId: string | undefined;
    adminKey: string;
    onAuthError?: () => void;
}) => {
    const [events, setEvents] = useState<TimelineEvent[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [page, setPage] = useState(0);
    const [hasMore, setHasMore] = useState(true);
    const onAuthErrorRef = useRef(onAuthError);

    onAuthErrorRef.current = onAuthError;

    const fetchPage = useCallback(async (pageNum: number) => {
        if (!userId || !adminKey) return;

        setLoading(true);
        try {
            const offset = pageNum * PAGE_SIZE;
            const client = createAdminApiClient({
                adminKey,
                onAuthError: () => onAuthErrorRef.current?.(),
            });
            const payload = await client.getUserTimeline(userId, { limit: PAGE_SIZE, offset });
            const newEvents: TimelineEvent[] = payload.events ?? [];

            setEvents(newEvents);
            setHasMore(newEvents.length >= PAGE_SIZE);
            setError(null);
        } catch (e) {
            if (isAdminAuthError(e)) {
                return;
            }
            setError(e instanceof Error ? e.message : "Failed to load timeline");
        } finally {
            setLoading(false);
        }
    }, [adminKey, userId]);

    // Reset pagination when switching to a different agent.
    useEffect(() => {
        setEvents([]);
        setError(null);
        setHasMore(true);
        setPage(0);
    }, [userId]);

    // Fetch on mount and when page changes.
    useEffect(() => {
        void fetchPage(page);
    }, [fetchPage, page]);

    const goToPage = useCallback((p: number) => setPage(p), []);
    const nextPage = useCallback(() => setPage((p) => p + 1), []);
    const prevPage = useCallback(() => setPage((p) => Math.max(0, p - 1)), []);
    const refresh = useCallback(() => fetchPage(page), [fetchPage, page]);

    return { events, loading, error, page, hasMore, goToPage, nextPage, prevPage, refresh };
};

import { useCallback, useEffect, useRef, useState } from "react";

export type TimelineEvent = {
    type: "order" | "order_cancelled" | "journal";
    data: {
        id: string;
        symbol?: string;
        market?: string;
        side?: string;
        quantity?: number;
        status?: string;
        filledPrice?: number | null;
        content?: string;
        tags?: string[];
        symbolName?: string | null;
    };
    reasoning: string | null;
    createdAt: string;
};

const PAGE_SIZE = 20;

export const useAgentTimeline = ({
    userId,
    adminKey,
}: {
    userId: string | undefined;
    adminKey: string;
}) => {
    const [events, setEvents] = useState<TimelineEvent[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [page, setPage] = useState(0);
    const [hasMore, setHasMore] = useState(true);

    const userIdRef = useRef(userId);
    userIdRef.current = userId;
    const adminKeyRef = useRef(adminKey);
    adminKeyRef.current = adminKey;

    const fetchPage = useCallback(async (pageNum: number) => {
        const uid = userIdRef.current;
        const key = adminKeyRef.current;
        if (!uid || !key) return;

        setLoading(true);
        try {
            const offset = pageNum * PAGE_SIZE;
            const response = await fetch(
                `/api/admin/users/${uid}/timeline?limit=${PAGE_SIZE}&offset=${offset}`,
                { headers: { Authorization: `Bearer ${key}` } },
            );

            if (!response.ok) {
                throw new Error(`Request failed with status ${response.status}`);
            }

            const payload = await response.json();
            const newEvents: TimelineEvent[] = payload.events ?? [];

            setEvents(newEvents);
            setHasMore(newEvents.length >= PAGE_SIZE);
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to load timeline");
        } finally {
            setLoading(false);
        }
    }, []);

    // Fetch on mount and when page changes
    useEffect(() => {
        void fetchPage(page);
    }, [page, fetchPage]);

    const goToPage = useCallback((p: number) => setPage(p), []);
    const nextPage = useCallback(() => setPage((p) => p + 1), []);
    const prevPage = useCallback(() => setPage((p) => Math.max(0, p - 1)), []);

    return { events, loading, error, page, hasMore, goToPage, nextPage, prevPage };
};

import { useMemo, useState } from "react";
import {
    ArrowDownRight,
    ArrowUpRight,
    BookOpen,
    ChevronLeft,
    ChevronRight,
    XCircle,
} from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { formatCurrency, formatNumber } from "../lib/admin";
import type { TimelineEvent } from "../lib/useAgentTimeline";

const EVENT_TYPES = [
    { value: "all", label: "All" },
    { value: "order", label: "Orders" },
    { value: "order_cancelled", label: "Cancelled" },
    { value: "journal", label: "Journal" },
] as const;

const eventIcon = (event: TimelineEvent) => {
    if (event.type === "journal") return <BookOpen className="h-4 w-4 text-blue-500" />;
    if (event.type === "order_cancelled") return <XCircle className="h-4 w-4 text-amber-500" />;
    if (event.data.side === "buy") return <ArrowUpRight className="h-4 w-4 text-emerald-500" />;
    return <ArrowDownRight className="h-4 w-4 text-rose-500" />;
};

const eventLabel = (event: TimelineEvent) => {
    if (event.type === "journal") return "Journal";
    if (event.type === "order_cancelled") return "Cancelled";
    return event.data.side === "buy" ? "Buy" : "Sell";
};

const badgeVariant = (event: TimelineEvent): "default" | "secondary" | "outline" | "success" | "danger" => {
    if (event.type === "journal") return "secondary";
    if (event.type === "order_cancelled") return "outline";
    if (event.data.side === "buy") return "success";
    return "danger";
};

const formatTime = (iso: string) => {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60_000);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

export const ActivityFeed = ({
    events,
    loading,
    page = 0,
    hasMore = false,
    onNextPage,
    onPrevPage,
    emptyMessage = "No activity yet.",
}: {
    events: TimelineEvent[];
    loading?: boolean;
    page?: number;
    hasMore?: boolean;
    onNextPage?: () => void;
    onPrevPage?: () => void;
    emptyMessage?: string;
}) => {
    const [typeFilter, setTypeFilter] = useState<string>("all");

    const filteredEvents = useMemo(() => {
        if (typeFilter === "all") return events;
        return events.filter((e) => e.type === typeFilter);
    }, [events, typeFilter]);

    return (
        <Card className="bg-card/55 hover:border-primary/30">
            <CardHeader className="gap-3 md:flex-row md:items-center md:justify-between md:space-y-0">
                <div>
                    <CardTitle>Recent Activity</CardTitle>
                    <CardDescription>Orders, cancellations, and journal entries.</CardDescription>
                </div>
                <div className="flex rounded-lg border border-border/50 p-0.5">
                    {EVENT_TYPES.map((t) => (
                        <Button
                            key={t.value}
                            variant={typeFilter === t.value ? "default" : "ghost"}
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setTypeFilter(t.value)}
                        >
                            {t.label}
                        </Button>
                    ))}
                </div>
            </CardHeader>
            <CardContent>
                {loading ? (
                    <div className="py-8 text-center text-sm text-muted-foreground">
                        Loading activity…
                    </div>
                ) : filteredEvents.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-muted-foreground/35 bg-muted/35 p-4 text-sm text-muted-foreground">
                        {typeFilter !== "all" ? `No ${typeFilter} events on this page.` : emptyMessage}
                    </div>
                ) : (
                    <div className="space-y-3">
                        {filteredEvents.map((event) => (
                            <div
                                key={`${event.type}-${event.data.id}`}
                                className="group flex gap-3 rounded-lg border border-border/50 bg-background/50 p-3 transition-colors hover:border-border hover:bg-accent/30"
                            >
                                <div className="shrink-0 self-center">{eventIcon(event)}</div>
                                <div className="min-w-0 flex-1 space-y-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Badge variant={badgeVariant(event)} className="text-xs">
                                            {eventLabel(event)}
                                        </Badge>
                                        {event.type !== "journal" && event.data.symbolName ? (
                                            <span className="text-xs text-foreground/80 truncate max-w-[300px]" title={event.data.symbolName}>
                                                {event.data.symbolName}
                                            </span>
                                        ) : event.type !== "journal" && event.data.symbol ? (
                                            <span className="font-mono text-xs text-muted-foreground truncate max-w-[200px]">
                                                {event.data.symbol}
                                            </span>
                                        ) : null}
                                        {event.type !== "journal" && event.data.quantity ? (
                                            <span className="text-xs text-muted-foreground">
                                                ×{formatNumber(event.data.quantity)}
                                            </span>
                                        ) : null}
                                        {event.type === "order" && event.data.filledPrice != null ? (
                                            <span className="text-xs font-medium">
                                                @ {formatCurrency(event.data.filledPrice)}
                                            </span>
                                        ) : null}
                                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                                            {formatTime(event.createdAt)}
                                        </span>
                                    </div>

                                    {event.type === "journal" && event.data.content ? (
                                        <p className="text-sm leading-relaxed text-foreground/80">
                                            {event.data.content}
                                        </p>
                                    ) : null}

                                    {event.type === "journal" && event.data.tags && event.data.tags.length > 0 ? (
                                        <div className="flex flex-wrap gap-1 pt-0.5">
                                            {event.data.tags.map((tag) => (
                                                <Badge key={tag} variant="outline" className="text-[10px] px-1.5 py-0">
                                                    {tag}
                                                </Badge>
                                            ))}
                                        </div>
                                    ) : null}

                                    {event.reasoning ? (
                                        <p className="text-xs leading-relaxed text-muted-foreground italic">
                                            "{event.reasoning}"
                                        </p>
                                    ) : null}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* Pagination */}
                {(page > 0 || hasMore) ? (
                    <div className="flex items-center justify-between border-t border-border/50 pt-3 mt-3">
                        <p className="text-xs text-muted-foreground">Page {page + 1}</p>
                        <div className="flex items-center gap-1">
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={page === 0 || loading}
                                onClick={onPrevPage}
                                className="h-8 w-8 p-0"
                            >
                                <ChevronLeft className="h-4 w-4" />
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={!hasMore || loading}
                                onClick={onNextPage}
                                className="h-8 w-8 p-0"
                            >
                                <ChevronRight className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>
                ) : null}
            </CardContent>
        </Card>
    );
};

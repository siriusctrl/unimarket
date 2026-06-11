import { useMemo, useState } from "react";
import {
    AlertTriangle,
    ArrowDownRight,
    ArrowUpRight,
    BookOpen,
    ChevronLeft,
    ChevronRight,
    Coins,
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
    { value: "order.cancelled", label: "Cancelled" },
    { value: "position.liquidated", label: "Liquidations" },
    { value: "funding.applied", label: "Funding" },
    { value: "journal", label: "Journal" },
] as const;

const eventIcon = (event: TimelineEvent) => {
    if (event.type === "journal") return <BookOpen className="h-4 w-4 text-primary" />;
    if (event.type === "order.cancelled") return <XCircle className="h-4 w-4 text-amber-500" />;
    if (event.type === "position.liquidated") return <AlertTriangle className="h-4 w-4 text-rose-500" />;
    if (event.type === "funding.applied") return <Coins className="h-4 w-4 text-primary" />;
    if (event.data.side === "buy") return <ArrowUpRight className="h-4 w-4 text-emerald-500" />;
    return <ArrowDownRight className="h-4 w-4 text-rose-500" />;
};

const eventLabel = (event: TimelineEvent) => {
    if (event.type === "journal") return "Journal";
    if (event.type === "order.cancelled") return "Cancelled";
    if (event.type === "position.liquidated") return "Liquidated";
    if (event.type === "funding.applied") return "Funding";
    return event.data.side === "buy" ? "Buy" : "Sell";
};

const badgeVariant = (event: TimelineEvent): "default" | "secondary" | "outline" | "success" | "danger" => {
    if (event.type === "journal") return "secondary";
    if (event.type === "order.cancelled") return "outline";
    if (event.type === "position.liquidated") return "danger";
    if (event.type === "funding.applied") return "secondary";
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
        <Card className="hover:border-primary/30">
            <CardHeader className="gap-3 md:flex-row md:items-center md:justify-between md:space-y-0">
                <div>
                    <CardTitle>Audit timeline</CardTitle>
                    <CardDescription>Agent actions, funding events, liquidations, and review notes.</CardDescription>
                </div>
                <div className="flex flex-wrap rounded-md border border-border/60 bg-background/50 p-0.5">
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
                    <div className="space-y-3">
                        <div className="h-16 animate-pulse rounded-md bg-muted/70" />
                        <div className="h-20 animate-pulse rounded-md bg-muted/60" />
                        <div className="h-16 animate-pulse rounded-md bg-muted/50" />
                    </div>
                ) : filteredEvents.length === 0 ? (
                    <div className="rounded-md border border-dashed border-muted-foreground/35 bg-muted/35 p-4 text-sm text-muted-foreground">
                        {typeFilter !== "all" ? `No ${typeFilter === "order.cancelled" ? "cancelled" : typeFilter} events on this page.` : emptyMessage}
                    </div>
                ) : (
                    <div className="relative space-y-3 before:absolute before:bottom-2 before:left-[1.18rem] before:top-2 before:w-px before:bg-border/70">
                        {filteredEvents.map((event) => (
                            <div
                                key={`${event.type}-${event.data.id}`}
                                className="group relative flex gap-3 rounded-md border border-border/55 bg-background/70 p-3 transition-colors hover:border-primary/35 hover:bg-accent/25"
                            >
                                <div className="z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border/70 bg-card shadow-panel">
                                    {eventIcon(event)}
                                </div>
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
                                        {event.type === "position.liquidated" && event.data.executionPrice != null ? (
                                            <span className="text-xs font-medium">
                                                @ {formatCurrency(event.data.executionPrice)}
                                            </span>
                                        ) : null}
                                        {event.type === "funding.applied" && typeof event.data.payment === "number" ? (
                                            <span className="text-xs font-medium">
                                                {event.data.payment >= 0 ? "+" : ""}{formatCurrency(event.data.payment)}
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

                                    {event.type === "funding.applied" ? (
                                        <p className="text-xs leading-relaxed text-foreground/75">
                                            Funding rate {event.data.fundingRate?.toFixed(6) ?? "—"} applied to {event.data.market}:{event.data.symbol}.
                                        </p>
                                    ) : null}

                                    {event.type === "position.liquidated" ? (
                                        <p className="text-xs leading-relaxed text-foreground/75">
                                            Trigger {formatCurrency(event.data.triggerPrice ?? 0)}, execution {formatCurrency(event.data.executionPrice ?? 0)}, payout {formatCurrency(event.data.netPayout ?? 0)}.
                                        </p>
                                    ) : null}

                                    {event.reasoning ? (
                                        <div className="mt-2 rounded-md border border-primary/20 bg-primary/8 p-2.5">
                                            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">
                                                Audit note
                                            </p>
                                            <p className="text-xs leading-relaxed text-foreground/80">
                                                {event.reasoning}
                                            </p>
                                        </div>
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

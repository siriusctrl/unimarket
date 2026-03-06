import { useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { formatSignedCurrency } from "../../lib/admin";
import type { AgentOption, PortfolioData, PortfolioPosition } from "../../lib/admin-api";

const RECENT_PAGE_SIZE = 5;

export const PortfolioPanels = ({
  selectedAgent,
  portfolio,
  onClosePosition,
}: {
  selectedAgent: AgentOption | null;
  portfolio: PortfolioData | null;
  onClosePosition?: (position: PortfolioPosition) => void;
}) => {
  const [recentPage, setRecentPage] = useState(0);

  if (!selectedAgent) {
    return null;
  }

  const recentOrders = portfolio?.recentOrders ?? [];
  const totalRecentPages = Math.max(1, Math.ceil(recentOrders.length / RECENT_PAGE_SIZE));
  const clampedPage = Math.min(recentPage, totalRecentPages - 1);
  const pagedOrders = recentOrders.slice(
    clampedPage * RECENT_PAGE_SIZE,
    (clampedPage + 1) * RECENT_PAGE_SIZE,
  );

  return (
    <>
      {portfolio && portfolio.positions.length > 0 ? (
        <Card className="animate-in fade-in-0 border-border/50 bg-card/45 duration-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Open Positions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {portfolio.positions.slice(0, 8).map((position) => (
              <div
                key={`${position.market}:${position.symbol}`}
                className="group/pos flex items-center justify-between rounded-md bg-muted/30 px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="max-w-[120px] truncate font-mono font-medium">{position.symbol}</p>
                    {position.leverage && position.leverage > 1 ? (
                      <span className="rounded bg-amber-500/15 px-1 py-px text-[10px] font-semibold tabular-nums text-amber-600 dark:text-amber-400">
                        {position.leverage}×
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className={`text-[10px] font-semibold ${position.quantity > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                      {position.quantity > 0 ? "LONG" : "SHORT"}
                    </span>
                    <span className="text-muted-foreground/40">·</span>
                    <span className="capitalize text-muted-foreground">{position.market}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="text-right">
                    <p className="font-mono">
                      {position.quantity} @ {position.avgCost.toFixed(2)}
                    </p>
                    {position.unrealizedPnl !== null ? (
                      <p className={position.unrealizedPnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
                        {formatSignedCurrency(position.unrealizedPnl)}
                      </p>
                    ) : null}
                  </div>
                  {onClosePosition ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover/pos:opacity-100 hover:bg-rose-500/15 hover:text-rose-500"
                      onClick={() => onClosePosition(position)}
                      title="Close position"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
            {portfolio.positions.length > 8 ? (
              <p className="text-center text-[10px] text-muted-foreground">+{portfolio.positions.length - 8} more positions</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {portfolio && portfolio.openOrders.length > 0 ? (
        <Card className="animate-in fade-in-0 border-border/50 bg-card/45 duration-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Open Orders</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {portfolio.openOrders.slice(0, 10).map((order) => (
              <div
                key={order.id}
                className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-2 text-xs"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Badge
                    variant="outline"
                    className={`px-1.5 text-[10px] ${order.side === "buy"
                      ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                      : "border-rose-500/40 text-rose-600 dark:text-rose-400"
                      }`}
                  >
                    {order.side.toUpperCase()}
                  </Badge>
                  <span className="max-w-[100px] truncate font-mono">{order.symbol}</span>
                </div>
                <div className="text-right">
                  <p className="font-mono">
                    {order.quantity} @ {order.limitPrice?.toFixed(2) ?? "—"}
                  </p>
                  <p className="capitalize text-muted-foreground">{order.status}</p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {recentOrders.length > 0 ? (
        <Card className="animate-in fade-in-0 border-border/50 bg-card/45 duration-200">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Recent Orders</CardTitle>
              {totalRecentPages > 1 ? (
                <div className="flex items-center gap-1">
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {clampedPage + 1}/{totalRecentPages}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={clampedPage === 0}
                    onClick={() => setRecentPage((p) => Math.max(0, p - 1))}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={clampedPage >= totalRecentPages - 1}
                    onClick={() => setRecentPage((p) => Math.min(totalRecentPages - 1, p + 1))}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {pagedOrders.map((order) => (
              <div
                key={order.id}
                className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-2 text-xs"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Badge
                    variant="outline"
                    className={`px-1.5 text-[10px] ${order.side === "buy"
                      ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                      : "border-rose-500/40 text-rose-600 dark:text-rose-400"
                      }`}
                  >
                    {order.side.toUpperCase()}
                  </Badge>
                  <span className="max-w-[100px] truncate font-mono">{order.symbol}</span>
                </div>
                <div className="text-right">
                  <p className="font-mono">
                    {order.quantity} @ {order.filledPrice?.toFixed(2) ?? order.limitPrice?.toFixed(2) ?? "—"}
                  </p>
                  <p className="capitalize text-muted-foreground">{order.status}</p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </>
  );
};

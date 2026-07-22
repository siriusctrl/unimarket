import { CircleCheck, CircleDot, TriangleAlert } from "lucide-react";

import { formatCurrency, formatNumber, formatSignedCurrency } from "../../lib/dashboard";
import type { OverviewResponse } from "../../lib/dashboard-api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

const valueTone = (value: number | null) => {
  if (value === null || value === 0) return "text-foreground";
  return value > 0
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
};

export const PortfolioSummary = ({ overview }: { overview: OverviewResponse }) => {
  const pricedTotal = overview.valuation.pricedPositions + overview.valuation.unpricedPositions;
  const coverage = pricedTotal === 0 ? 100 : (overview.valuation.pricedPositions / pricedTotal) * 100;

  return (
    <section
      className="overflow-hidden rounded-lg border border-border/70 bg-card shadow-panel"
      aria-labelledby="portfolio-summary-title"
    >
      <div className="grid grid-cols-2 xl:grid-cols-[1.35fr_repeat(3,minmax(0,1fr))]">
        <div className="col-span-2 bg-primary/[0.07] px-5 py-5 sm:px-6 xl:col-span-1 xl:border-r xl:border-border/65">
          <p id="portfolio-summary-title" className="text-xs font-medium text-primary">Paper portfolio</p>
          <p className="mt-2 font-mono text-3xl font-semibold tracking-[-0.04em] tabular-nums">
            {formatCurrency(overview.totals.equity)}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {formatNumber(overview.totals.users)} agents across {formatNumber(overview.markets.length)} markets
          </p>
        </div>

        <dl className="contents">
          <div className="border-t border-border/65 px-5 py-5 xl:border-l-0 xl:border-t-0">
            <dt className="text-xs text-muted-foreground">Unrealized PnL</dt>
            <dd className={`mt-2 font-mono text-xl font-semibold tabular-nums ${valueTone(overview.totals.unrealizedPnl)}`}>
              {formatSignedCurrency(overview.totals.unrealizedPnl)}
            </dd>
            <p className="mt-2 text-xs text-muted-foreground">Known mark-to-market result</p>
          </div>
          <div className="border-l border-t border-border/65 px-5 py-5 xl:border-t-0">
            <dt className="text-xs text-muted-foreground">Marked value</dt>
            <dd className="mt-2 font-mono text-xl font-semibold tabular-nums">
              {formatCurrency(overview.totals.marketValue)}
            </dd>
            <p className="mt-2 text-xs text-muted-foreground">{formatNumber(overview.totals.positions)} positions · not perp notional</p>
          </div>
          <div className="col-span-2 border-t border-border/65 px-5 py-5 xl:col-span-1 xl:border-l xl:border-t-0">
            <dt className="flex items-center gap-2 text-xs text-muted-foreground">
              {overview.valuation.status === "complete" ? (
                <CircleCheck className="h-3.5 w-3.5 text-primary" />
              ) : (
                <TriangleAlert className="h-3.5 w-3.5 text-amber-500" />
              )}
              Valuation coverage
            </dt>
            <dd className="mt-2 font-mono text-xl font-semibold tabular-nums">{coverage.toFixed(0)}%</dd>
            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <CircleDot className="h-3 w-3" />
              {formatNumber(overview.valuation.pricedPositions)} priced · {formatNumber(overview.valuation.unpricedPositions)} unpriced
            </p>
          </div>
        </dl>
      </div>
    </section>
  );
};

export const OperationalStatus = ({ overview }: { overview: OverviewResponse }) => {
  const totalKnownValue = Math.max(overview.totals.knownMarketValue, 1);
  const activeAgents = overview.agents.filter((agent) => agent.totals.positions > 0).length;
  const losingAgents = overview.agents.filter(
    (agent) => agent.totals.unrealizedPnl !== null && agent.totals.unrealizedPnl < 0,
  );

  return (
    <Card className="h-full shadow-none">
      <CardHeader className="gap-3 border-b border-border/60">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>System posture</CardTitle>
            <CardDescription>Coverage, activity, and marked-value mix</CardDescription>
          </div>
          <div className={overview.valuation.status === "complete"
            ? "flex items-center gap-2 text-xs font-medium text-primary"
            : "flex items-center gap-2 text-xs font-medium text-amber-600 dark:text-amber-300"}
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-25" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
            </span>
            {overview.valuation.status === "complete" ? "Valuation complete" : "Valuation partial"}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-5 pt-5">
        <dl className="grid grid-cols-2 gap-x-5 gap-y-4">
          <div>
            <dt className="text-xs text-muted-foreground">Active books</dt>
            <dd className="mt-1 font-mono text-lg font-semibold tabular-nums">{activeAgents}/{overview.agents.length}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Valuation issues</dt>
            <dd className={overview.valuation.issueCount > 0
              ? "mt-1 font-mono text-lg font-semibold text-amber-600 dark:text-amber-300"
              : "mt-1 font-mono text-lg font-semibold tabular-nums"}
            >
              {overview.valuation.issueCount}
            </dd>
          </div>
        </dl>

        <section className="border-t border-border/60 pt-4" aria-labelledby="market-value-mix-title">
          <div className="flex items-center justify-between gap-3">
            <h3 id="market-value-mix-title" className="text-sm font-semibold">Market value mix</h3>
            <span className="text-xs text-muted-foreground">known value</span>
          </div>
          <div className="mt-3 space-y-3">
            {overview.markets.map((market) => {
              const share = (market.knownMarketValue / totalKnownValue) * 100;
              return (
                <div key={market.marketId}>
                  <div className="flex items-center justify-between gap-4 text-xs">
                    <span className="font-medium">{market.marketName}</span>
                    <span className="font-mono tabular-nums text-muted-foreground">
                      {formatCurrency(market.knownMarketValue)} · {share.toFixed(0)}%
                    </span>
                  </div>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary/75" style={{ width: `${Math.max(share, 2)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="border-t border-border/60 pt-4" aria-labelledby="attention-title">
          <div className="flex items-center justify-between gap-3">
            <h3 id="attention-title" className="text-sm font-semibold">Needs attention</h3>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">{losingAgents.length}</span>
          </div>
          {losingAgents.length === 0 ? (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">No agent books currently show a known unrealized loss.</p>
          ) : (
            <div className="mt-2 space-y-2">
              {losingAgents.slice(0, 3).map((agent) => (
                <div key={agent.userId} className="flex items-center justify-between gap-3 text-xs">
                  <span className="truncate">{agent.userName}</span>
                  <span className="shrink-0 font-mono tabular-nums text-rose-600 dark:text-rose-400">
                    {formatSignedCurrency(agent.totals.unrealizedPnl)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
};

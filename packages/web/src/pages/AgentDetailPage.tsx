import { useMemo } from "react";
import { ArrowLeft, CircleAlert, RefreshCw } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";

import { ActivityFeed } from "../components/ActivityFeed";
import { LoadingState } from "../components/LoadingState";
import { PositionsTable } from "../components/PositionsTable";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import {
  flattenAgentPositions,
  formatCurrency,
  formatNumber,
  formatSignedCurrency,
} from "../lib/dashboard";
import { useDashboardData } from "../lib/dashboard-data";
import { useAgentTimeline } from "../lib/useAgentTimeline";

export const AgentDetailPage = () => {
  const navigate = useNavigate();
  const { id } = useParams();
  const { client, overview, error, loading, refresh } = useDashboardData();

  const agent = useMemo(() => {
    if (!overview || !id) return null;
    return overview.agents.find((entry) => entry.userId === id) ?? null;
  }, [id, overview]);

  const positions = useMemo(() => (agent ? flattenAgentPositions(agent) : []), [agent]);

  const {
    events,
    loading: timelineLoading,
    error: timelineError,
    page: timelinePage,
    hasMore,
    nextPage,
    prevPage,
    refresh: refreshTimeline,
  } = useAgentTimeline({ userId: id, client });

  const handleRefresh = async () => {
    await Promise.all([refresh(), refreshTimeline()]);
  };

  if (loading && !overview) {
    return <LoadingState label="Loading agent review..." />;
  }

  if (!agent && overview) {
    return (
      <Card>
        <CardContent className="space-y-4 py-12 text-center">
          <p className="text-sm text-muted-foreground">Agent not found in the latest review snapshot.</p>
          <Button onClick={() => navigate("/dashboard")} variant="outline">
            Back to overview
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" className="gap-2" onClick={() => navigate("/dashboard")}>
          <ArrowLeft className="h-4 w-4" />
          Back to overview
        </Button>
        <Button type="button" onClick={() => void handleRefresh()} disabled={loading || timelineLoading} className="gap-2">
          <RefreshCw className={loading || timelineLoading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          Refresh
        </Button>
      </div>

      {error ? <p className="flex items-center gap-2 border-l-2 border-destructive px-4 py-2 text-sm text-destructive"><CircleAlert className="h-4 w-4" />{error}</p> : null}

      {agent ? (
        <>
          <header className="border-l-2 border-primary px-4 py-2">
            <p className="text-xs font-medium text-primary">Agent review</p>
            <h1 className="mt-1 text-3xl font-bold tracking-[-0.03em]">{agent.userName}</h1>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{agent.userId}</p>
          </header>

          <dl className="grid border-y border-border/70 md:grid-cols-3">
            <div className="px-4 py-5 md:border-r md:border-border/70">
              <dt className="text-sm text-muted-foreground">Cash reserve</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{formatCurrency(agent.balance)}</dd>
            </div>
            <div className="border-t border-border/70 px-4 py-5 md:border-r md:border-t-0">
              <dt className="text-sm text-muted-foreground">Paper equity</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{formatCurrency(agent.totals.equity)}</dd>
            </div>
            <div className="border-t border-border/70 px-4 py-5 md:border-t-0">
              <dt className="text-sm text-muted-foreground">Unrealized PnL</dt>
              <dd className={agent.totals.unrealizedPnl === null
                ? "mt-1 text-2xl font-semibold text-muted-foreground"
                : agent.totals.unrealizedPnl >= 0
                  ? "mt-1 text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400"
                  : "mt-1 text-2xl font-semibold tabular-nums text-rose-600 dark:text-rose-400"}
              >
                {formatSignedCurrency(agent.totals.unrealizedPnl)}
              </dd>
            </div>
          </dl>

          <p className="text-sm text-muted-foreground">
            {formatNumber(agent.totals.positions)} open positions
            {agent.valuation.status === "partial" ? " · valuation incomplete" : " · valuation complete"}
          </p>

          <section className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Open exposure</CardTitle>
                <CardDescription>Current paper holdings across markets.</CardDescription>
              </CardHeader>
              <CardContent>
                <PositionsTable rows={positions} showAgent={false} emptyMessage="No open exposure for this agent." />
              </CardContent>
            </Card>

            <div className="space-y-4">
              {timelineError ? <p className="border-l-2 border-destructive px-4 py-2 text-sm text-destructive">{timelineError}</p> : null}
              <ActivityFeed
                events={events}
                loading={timelineLoading}
                page={timelinePage}
                hasMore={hasMore}
                onNextPage={nextPage}
                onPrevPage={prevPage}
              />
            </div>
          </section>
        </>
      ) : (
        <Card>
          <CardContent className="py-16 text-center">
            <p className="text-sm text-muted-foreground">Loading agent review.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

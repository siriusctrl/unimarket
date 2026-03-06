import { useMemo } from "react";
import { ArrowLeft, CircleAlert, RefreshCw } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";

import { ActivityFeed } from "../components/ActivityFeed";
import { LoadingState } from "../components/LoadingState";
import { PositionsTable } from "../components/PositionsTable";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import {
  clearAdminKey,
  flattenAgentPositions,
  formatCurrency,
  formatNumber,
  formatSignedCurrency,
  readStoredAdminKey,
} from "../lib/admin";
import { useAdminOverview } from "../lib/useAdminOverview";
import { useAgentTimeline } from "../lib/useAgentTimeline";

export const AgentDetailPage = () => {
  const navigate = useNavigate();
  const { id } = useParams();
  const adminKey = readStoredAdminKey();

  const handleAuthError = () => {
    clearAdminKey();
    navigate("/login", { replace: true });
  };

  const { overview, error, loading, refresh } = useAdminOverview({ adminKey, onAuthError: handleAuthError });

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
  } = useAgentTimeline({ userId: id, adminKey, onAuthError: handleAuthError });

  const handleRefresh = async () => {
    await Promise.all([refresh(), refreshTimeline()]);
  };

  if (loading && !overview) {
    return <LoadingState label="Loading agent snapshot..." />;
  }

  if (!agent && overview) {
    return (
      <Card className="bg-card/55">
        <CardContent className="space-y-4 py-12 text-center">
          <p className="text-sm text-muted-foreground">Agent not found in the latest overview.</p>
          <Button onClick={() => navigate("/dashboard")} variant="outline">
            Back to dashboard
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" className="gap-2" onClick={() => navigate("/dashboard")}>
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <Button type="button" onClick={() => void handleRefresh()} disabled={loading || timelineLoading} className="gap-2">
          <RefreshCw className={loading || timelineLoading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          Refresh
        </Button>
      </div>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/10 shadow-none">
          <CardContent className="flex items-center gap-2 py-4 text-sm text-destructive">
            <CircleAlert className="h-4 w-4" />
            {error}
          </CardContent>
        </Card>
      ) : null}

      {agent ? (
        <>
          {/* Agent header */}
          <Card className="border-primary/25 bg-card/55 shadow-panel backdrop-blur-xl animate-in fade-in-0 slide-in-from-top-1 duration-300">
            <CardHeader className="gap-3 md:flex-row md:items-center md:justify-between md:space-y-0">
              <div className="space-y-2">
                <Badge variant="secondary" className="w-fit">
                  Agent Detail
                </Badge>
                <CardTitle className="text-3xl font-bold tracking-tight">{agent.userName}</CardTitle>
                <CardDescription className="font-mono text-xs">{agent.userId}</CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">
                  {formatNumber(agent.totals.positions)} positions
                </Badge>
                <Badge variant={agent.totals.unrealizedPnl >= 0 ? "success" : "danger"}>
                  {formatSignedCurrency(agent.totals.unrealizedPnl)}
                </Badge>
              </div>
            </CardHeader>
          </Card>

          {/* KPI cards */}
          <section className="grid gap-4 md:grid-cols-3 animate-in fade-in-0 duration-300">
            <Card className="bg-card/55 hover:border-primary/30">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">Cash Balance</CardTitle>
                <CardDescription>Available funds for new positions</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">{formatCurrency(agent.balance)}</p>
              </CardContent>
            </Card>
            <Card className="bg-card/55 hover:border-primary/30">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">Portfolio Equity</CardTitle>
                <CardDescription>Cash plus marked value</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">{formatCurrency(agent.totals.equity)}</p>
              </CardContent>
            </Card>
            <Card className="bg-card/55 hover:border-primary/30">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">Unrealized PnL</CardTitle>
                <CardDescription>Based on latest cached marks</CardDescription>
              </CardHeader>
              <CardContent>
                <p
                  className={
                    agent.totals.unrealizedPnl >= 0
                      ? "text-2xl font-semibold text-emerald-600 dark:text-emerald-400"
                      : "text-2xl font-semibold text-rose-600 dark:text-rose-400"
                  }
                >
                  {formatSignedCurrency(agent.totals.unrealizedPnl)}
                </p>
              </CardContent>
            </Card>
          </section>

          {/* Positions + Activity */}
          <section className="space-y-4 animate-in fade-in-0 duration-300">
            <Card className="bg-card/55 hover:border-primary/30">
              <CardHeader>
                <CardTitle>Open Positions</CardTitle>
                <CardDescription>Current holdings across markets.</CardDescription>
              </CardHeader>
              <CardContent>
                <PositionsTable rows={positions} showAgent={false} emptyMessage="No open positions for this agent." />
              </CardContent>
            </Card>

            <div className="space-y-4">
              {timelineError ? (
                <Card className="border-destructive/40 bg-destructive/10 shadow-none">
                  <CardContent className="flex items-center gap-2 py-4 text-sm text-destructive">
                    <CircleAlert className="h-4 w-4" />
                    {timelineError}
                  </CardContent>
                </Card>
              ) : null}
              <ActivityFeed events={events} loading={timelineLoading} page={timelinePage} hasMore={hasMore} onNextPage={nextPage} onPrevPage={prevPage} />
            </div>
          </section>
        </>
      ) : (
        <Card className="bg-card/55">
          <CardContent className="py-16 text-center">
            <p className="text-sm text-muted-foreground">Loading agent details.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

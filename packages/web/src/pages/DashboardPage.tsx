import { useMemo, useState } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { AgentRoster } from "../components/dashboard/AgentRoster";
import { EquityTrend } from "../components/dashboard/EquityTrend";
import { PredictionLeaderboard } from "../components/dashboard/PredictionLeaderboard";
import { LoadingState } from "../components/LoadingState";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { useDashboardData } from "../lib/dashboard-data";
import { useEquityChart } from "../lib/useEquityChart";
import { useEquityHistory } from "../lib/useEquityHistory";

export const DashboardPage = () => {
  const navigate = useNavigate();
  const [range, setRange] = useState("1m");
  const { client, overview, error, loading, refresh } = useDashboardData();
  const history = useEquityHistory({ client, range });
  const chart = useEquityChart(overview, history.data);
  const generatedAtLabel = useMemo(
    () => overview ? new Date(overview.generatedAt).toLocaleString() : "—",
    [overview],
  );

  const refreshDashboard = async () => {
    await Promise.all([refresh(), history.refresh()]);
  };

  if (loading && !overview) return <LoadingState />;

  return (
    <div className="space-y-6">
      <header className="border-l-2 border-primary px-1 py-2 sm:px-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-3xl space-y-2">
            <p className="text-xs font-medium tracking-wide text-primary">Operator review</p>
            <h1 className="text-3xl font-bold tracking-[-0.03em] sm:text-4xl">Agent observation console</h1>
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Paper-market exposure, valuation health, and audited agent decisions.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right text-xs text-muted-foreground">
              <p className="font-medium">Last snapshot</p>
              <time>{generatedAtLabel}</time>
            </div>
            <Button
              type="button"
              onClick={() => void refreshDashboard()}
              disabled={loading || history.loading}
              className="gap-2"
            >
              <RefreshCw className={loading || history.loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              Refresh
            </Button>
          </div>
        </div>
      </header>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/10 shadow-none">
          <CardContent className="flex flex-col gap-2 py-4 text-sm text-destructive sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <CircleAlert className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
            <Button variant="outline" size="sm" className="w-fit" onClick={() => void refreshDashboard()}>Retry</Button>
          </CardContent>
        </Card>
      ) : history.error ? (
        <p className="border-l-2 border-amber-500 px-4 py-2 text-sm text-amber-700 dark:text-amber-300">
          Equity history is unavailable: {history.error}
        </p>
      ) : null}

      {overview?.valuation.status === "partial" ? (
        <p className="border-l-2 border-amber-500 px-4 py-2 text-sm text-amber-700 dark:text-amber-300">
          {overview.valuation.partialAgents} agents have unpriced positions. Aggregate equity and PnL remain unknown.
        </p>
      ) : null}

      {overview ? (
        <>
          <EquityTrend
            mode={chart.mode}
            onModeChange={chart.setMode}
            range={range}
            onRangeChange={setRange}
            loading={history.loading}
            rows={chart.rows}
            domain={chart.domain}
            agentNames={chart.agentNames}
            selectedAgents={chart.selectedAgents}
            colors={chart.colors}
          />
          <PredictionLeaderboard
            rows={overview.predictionLeaderboard}
            onOpenAgent={(userId) => navigate(`/agents/${userId}`)}
          />
          <AgentRoster
            agents={overview.agents}
            selectedAgents={chart.selectedAgents}
            colors={chart.colors}
            onToggleAgent={chart.toggleAgent}
            onSelectAll={chart.selectAll}
            onClearSelection={chart.clearSelection}
            onOpenAgent={(userId) => navigate(`/agents/${userId}`)}
          />
        </>
      ) : (
        <p className="py-16 text-center text-sm text-muted-foreground">Review overview is not available yet.</p>
      )}
    </div>
  );
};

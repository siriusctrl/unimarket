import { useMemo } from "react";
import { ArrowLeft, CircleAlert, Clock, RefreshCw } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";

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
    if (!overview || !id) {
      return null;
    }

    return overview.agents.find((entry) => entry.userId === id) ?? null;
  }, [id, overview]);

  const positions = useMemo(() => (agent ? flattenAgentPositions(agent) : []), [agent]);

  if (loading && !overview) {
    return <LoadingState label="Loading agent snapshot..." />;
  }

  if (!agent && overview) {
    return (
      <Card>
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" className="gap-2" onClick={() => navigate("/dashboard")}>
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <Button type="button" onClick={refresh} disabled={loading} className="gap-2">
          <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          Refresh
        </Button>
      </div>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/5 shadow-none">
          <CardContent className="flex items-center gap-2 py-4 text-sm text-destructive">
            <CircleAlert className="h-4 w-4" />
            {error}
          </CardContent>
        </Card>
      ) : null}

      {agent ? (
        <>
          <Card className="border-primary/20 bg-card/80 shadow-panel">
            <CardHeader className="gap-3 md:flex-row md:items-center md:justify-between md:space-y-0">
              <div className="space-y-2">
                <Badge variant="secondary" className="w-fit">
                  Agent Detail
                </Badge>
                <CardTitle className="text-3xl font-bold tracking-tight">{agent.userName}</CardTitle>
                <CardDescription className="font-mono text-xs">{agent.userId}</CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">single account</Badge>
                <Badge>{formatNumber(agent.totals.positions)} positions</Badge>
                <Badge variant={agent.totals.unrealizedPnl >= 0 ? "success" : "danger"}>
                  {formatSignedCurrency(agent.totals.unrealizedPnl)}
                </Badge>
              </div>
            </CardHeader>
          </Card>

          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">Cash Balance</CardTitle>
                <CardDescription>Available funds for new positions</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">{formatCurrency(agent.balance)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">Portfolio Equity</CardTitle>
                <CardDescription>Cash plus marked value</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">{formatCurrency(agent.totals.equity)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">Unrealized PnL</CardTitle>
                <CardDescription>Based on latest cached marks</CardDescription>
              </CardHeader>
              <CardContent>
                <p className={agent.totals.unrealizedPnl >= 0 ? "text-2xl font-semibold text-emerald-600" : "text-2xl font-semibold text-rose-600"}>
                  {formatSignedCurrency(agent.totals.unrealizedPnl)}
                </p>
              </CardContent>
            </Card>
          </section>

          <section className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
            <Card>
              <CardHeader>
                <CardTitle>Open Positions</CardTitle>
                <CardDescription>Current holdings across markets.</CardDescription>
              </CardHeader>
              <CardContent>
                <PositionsTable rows={positions} showAgent={false} emptyMessage="No open positions for this agent." />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  Decision Timeline
                </CardTitle>
                <CardDescription>Audit trail for automated actions.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-lg border border-dashed border-muted-foreground/30 bg-muted/40 p-4 text-sm text-muted-foreground">
                  Timeline entries are not available from the overview endpoint yet.
                </div>
              </CardContent>
            </Card>
          </section>
        </>
      ) : (
        <Card>
          <CardContent className="py-16 text-center">
            <p className="text-sm text-muted-foreground">Loading agent details.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

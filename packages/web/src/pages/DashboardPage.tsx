import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  RefreshCw,
  Search,
  Trophy,
  Users,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { LoadingState } from "../components/LoadingState";
import {
  chartPalette,
  formatCompactNumber,
  formatCurrency,
  formatNumber,
  formatSignedCurrency,
} from "../lib/dashboard";
import { useDashboardOverview } from "../lib/useDashboardOverview";
import { useEquityHistory } from "../lib/useEquityHistory";
import { useDashboardClient } from "../lib/useDashboardClient";

const AGENTS_PER_PAGE = 6;
const RANGE_OPTIONS = ["1w", "1m", "3m", "6m", "1y"] as const;
const RANGE_LABELS: Record<string, string> = {
  "1w": "1W",
  "1m": "1M",
  "3m": "3M",
  "6m": "6M",
  "1y": "1Y",
};
type ChartMode = "equity" | "return";

const formatScore = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return "N/A";
  return value.toFixed(4);
};

const formatSignedPercent = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return "N/A";
  const percentage = value * 100;
  return `${percentage > 0 ? "+" : ""}${percentage.toFixed(1)}%`;
};

const formatHours = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return "N/A";
  if (value < 24) return `${value.toFixed(1)}h`;
  return `${(value / 24).toFixed(1)}d`;
};

export const DashboardPage = () => {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [range, setRange] = useState<string>("1m");
  const [chartMode, setChartMode] = useState<ChartMode>("equity");
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const { client } = useDashboardClient();

  const { overview, error, loading, refresh } = useDashboardOverview({ client });
  const { data: historyData, error: historyError, loading: historyLoading, refresh: refreshHistory } = useEquityHistory({
    client,
    range,
  });

  const handleRefresh = async () => {
    await Promise.all([refresh(), refreshHistory()]);
  };

  const chartSeries = useMemo(() => {
    const historicalSeries = historyData?.series ?? [];
    const liveAgents = overview?.agents ?? [];

    if (historicalSeries.length === 0 && liveAgents.length === 0) {
      return [];
    }

    const historicalByUserId = new Map(historicalSeries.map((series) => [series.userId, series]));
    const mergedSeries = liveAgents.map((agent) => {
      const existing = historicalByUserId.get(agent.userId);
      const snapshots = [...(existing?.snapshots ?? [])];

      if (overview?.generatedAt) {
        if (
          agent.totals.equity === null
          || agent.totals.marketValue === null
          || agent.totals.unrealizedPnl === null
        ) {
          return {
            userId: agent.userId,
            userName: agent.userName,
            snapshots,
          };
        }

        const liveSnapshot = {
          snapshotAt: overview.generatedAt,
          equity: agent.totals.equity,
          balance: agent.balance,
          marketValue: agent.totals.marketValue,
          unrealizedPnl: agent.totals.unrealizedPnl,
        };
        const lastSnapshot = snapshots[snapshots.length - 1];
        const sameTimestamp = lastSnapshot?.snapshotAt === liveSnapshot.snapshotAt;
        const sameValues = Boolean(
          lastSnapshot
            && lastSnapshot.equity === liveSnapshot.equity
            && lastSnapshot.balance === liveSnapshot.balance
            && lastSnapshot.marketValue === liveSnapshot.marketValue
            && lastSnapshot.unrealizedPnl === liveSnapshot.unrealizedPnl,
        );

        if (!sameTimestamp && (!sameValues || snapshots.length === 0)) {
          snapshots.push(liveSnapshot);
        }
      }

      return {
        userId: agent.userId,
        userName: agent.userName,
        snapshots,
      };
    });

    const seenUserIds = new Set(mergedSeries.map((series) => series.userId));
    for (const series of historicalSeries) {
      if (!seenUserIds.has(series.userId)) {
        mergedSeries.push(series);
      }
    }

    return mergedSeries.filter((series) => series.snapshots.length > 0);
  }, [historyData, overview]);

  const generatedAtLabel = useMemo(() => {
    if (!overview?.generatedAt) return "-";
    return new Date(overview.generatedAt).toLocaleString();
  }, [overview?.generatedAt]);

  /* ----- build chart data from equity history ----- */
  const { chartData, agentNames, agentColors } = useMemo(() => {
    if (chartSeries.length === 0) {
      return { chartData: [], agentNames: [] as string[], agentColors: {} as Record<string, string> };
    }

    // Collect all unique timestamps across all agents
    const timestampSet = new Set<string>();
    for (const agent of chartSeries) {
      for (const snap of agent.snapshots) {
        timestampSet.add(snap.snapshotAt);
      }
    }
    const allTimestamps = [...timestampSet].sort();

    // Build name list + color map
    const names = chartSeries.map((s) => s.userName);
    const colors: Record<string, string> = {};
    chartSeries.forEach((s, i) => {
      colors[s.userName] = chartPalette[i % chartPalette.length];
    });

    // For return mode, we need the initial equity for each agent
    const initialEquity: Record<string, number> = {};
    if (chartMode === "return") {
      for (const agent of chartSeries) {
        if (agent.snapshots.length > 0) {
          initialEquity[agent.userName] = agent.snapshots[0].equity;
        }
      }
    }

    // Build per-timestamp map for each agent (for fast lookup)
    const agentDataMap = new Map<string, Map<string, number>>();
    for (const agent of chartSeries) {
      const map = new Map<string, number>();
      for (const snap of agent.snapshots) {
        const value =
          chartMode === "return"
            ? initialEquity[agent.userName]
              ? ((snap.equity - initialEquity[agent.userName]) / initialEquity[agent.userName]) * 100
              : 0
            : snap.equity;
        map.set(snap.snapshotAt, Number(value.toFixed(2)));
      }
      agentDataMap.set(agent.userName, map);
    }

    // Fill chart rows: each row has a timestamp + one key per agent
    const data = allTimestamps.map((ts) => {
      const row: Record<string, string | number> = {
        time: new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
      };
      for (const agent of chartSeries) {
        const val = agentDataMap.get(agent.userName)?.get(ts);
        if (val !== undefined) row[agent.userName] = val;
      }
      return row;
    });

    return { chartData: data, agentNames: names, agentColors: colors };
  }, [chartMode, chartSeries]);

  // Compute Y-axis domain from selected agents with symmetric padding
  const yDomain = useMemo((): [number, number] | undefined => {
    if (chartData.length === 0 || selectedAgents.size === 0) return undefined;
    let min = Infinity;
    let max = -Infinity;
    for (const row of chartData) {
      for (const name of selectedAgents) {
        const val = row[name];
        if (typeof val === "number") {
          if (val < min) min = val;
          if (val > max) max = val;
        }
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
    const range = max - min;
    const pad = range > 0 ? range * 0.15 : Math.max(Math.abs(max) * 0.05, 1);
    return [min - pad, max + pad];
  }, [chartData, selectedAgents]);

  // Initialize selectedAgents to top 5 when overview first loads
  useEffect(() => {
    if (overview && selectedAgents.size === 0) {
      const top5 = overview.agents.slice(0, 5).map((a) => a.userName);
      setSelectedAgents(new Set(top5));
    }
  }, [overview]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleAgent = (name: string) => {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const selectAllAgents = () => {
    if (overview) {
      setSelectedAgents(new Set(overview.agents.map((a) => a.userName)));
    }
  };

  const clearAllAgents = () => setSelectedAgents(new Set());

  /* ----- filtered + paginated agents ----- */
  const filteredAgents = useMemo(() => {
    if (!overview) return [];
    const q = search.trim().toLowerCase();
    if (!q) return overview.agents;
    return overview.agents.filter((agent) =>
      [agent.userName, agent.userId].join(" ").toLowerCase().includes(q),
    );
  }, [overview, search]);

  useEffect(() => {
    const maxPage = Math.max(0, Math.ceil(filteredAgents.length / AGENTS_PER_PAGE) - 1);
    setPage((prev) => Math.min(prev, maxPage));
  }, [filteredAgents.length]);

  const totalPages = Math.max(1, Math.ceil(filteredAgents.length / AGENTS_PER_PAGE));
  const safePage = Math.min(page, totalPages - 1);
  const pagedAgents = filteredAgents.slice(safePage * AGENTS_PER_PAGE, (safePage + 1) * AGENTS_PER_PAGE);

  const handleSearch = (value: string) => {
    setSearch(value);
    setPage(0);
  };

  const tickStyle = {
    fill: "hsl(var(--muted-foreground))",
    fontSize: 11,
    fontFamily: "IBM Plex Mono, monospace",
  };

  const tooltipStyle = {
    backgroundColor: "hsl(var(--popover) / 0.97)",
    border: "1px solid hsl(var(--border))",
    borderRadius: "12px",
    color: "hsl(var(--popover-foreground))",
    boxShadow: "var(--shadow-panel)",
  } as const;

  if (loading && !overview) {
    return <LoadingState />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card className="border-primary/25 animate-in fade-in-0 slide-in-from-top-1 duration-300">
        <CardHeader className="gap-4 md:flex-row md:items-center md:justify-between md:space-y-0">
          <div className="space-y-2">
            <Badge variant="secondary" className="w-fit gap-1 border border-border/40">
              <Users className="h-3 w-3" />
              Review workspace
            </Badge>
            <CardTitle className="text-3xl font-bold tracking-normal sm:text-4xl">Agent observation console</CardTitle>
            <CardDescription>
              Review agent-run paper market exposure, valuation health, and recent outcomes.
            </CardDescription>
          </div>

          <div className="flex flex-wrap items-center gap-3 md:justify-end">
            <div className="text-xs text-muted-foreground md:text-right">
              <p className="font-semibold uppercase tracking-wide">Last snapshot</p>
              <p>{generatedAtLabel}</p>
            </div>
            <Button type="button" onClick={() => void handleRefresh()} disabled={loading || historyLoading} className="gap-2">
              <RefreshCw className={loading || historyLoading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              Refresh
            </Button>
          </div>
        </CardHeader>
      </Card>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/10 shadow-none animate-in fade-in-0 duration-200">
          <CardContent className="flex flex-col gap-2 py-4 text-sm text-destructive sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <CircleAlert className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
            <Button type="button" variant="outline" size="sm" className="w-fit border-destructive/30 text-destructive hover:bg-destructive/10" onClick={() => void handleRefresh()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : historyError ? (
        <Card className="border-amber-500/40 bg-amber-500/10 shadow-none animate-in fade-in-0 duration-200">
          <CardContent className="flex items-center gap-2 py-4 text-sm text-amber-700 dark:text-amber-300">
            <CircleAlert className="h-4 w-4" />
            Equity history is temporarily unavailable: {historyError}
          </CardContent>
        </Card>
      ) : null}

      {overview?.valuation.status === "partial" ? (
        <Card className="border-amber-500/40 bg-amber-500/10 shadow-none animate-in fade-in-0 duration-200">
          <CardContent className="flex items-center gap-2 py-4 text-sm text-amber-700 dark:text-amber-300">
            <CircleAlert className="h-4 w-4" />
            {overview.valuation.partialAgents} agents have partial valuation. Equity and aggregate PnL stay unknown until every open position has a fresh price.
          </CardContent>
        </Card>
      ) : null}

      {overview ? (
        <>
          {/* Equity / Return line chart */}
          <Card className="border-border/75 hover:border-primary/35 animate-in fade-in-0 duration-300">
            <CardHeader className="gap-3 md:flex-row md:items-center md:justify-between md:space-y-0">
              <div>
                <CardTitle>{chartMode === "equity" ? "Equity trend" : "Return trend"}</CardTitle>
                <CardDescription>
                  {chartMode === "equity"
                    ? "Paper portfolio equity by agent across review snapshots"
                    : "Percentage return since the start of the selected period"}
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {/* Mode toggle */}
                <div className="flex rounded-md border border-border/60 bg-background/50 p-0.5">
                  <Button
                    variant={chartMode === "equity" ? "default" : "ghost"}
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setChartMode("equity")}
                  >
                    Equity
                  </Button>
                  <Button
                    variant={chartMode === "return" ? "default" : "ghost"}
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setChartMode("return")}
                  >
                    Return %
                  </Button>
                </div>
                {/* Time range */}
                <div className="flex rounded-md border border-border/60 bg-background/50 p-0.5">
                  {RANGE_OPTIONS.map((r) => (
                    <Button
                      key={r}
                      variant={range === r ? "default" : "ghost"}
                      size="sm"
                      className="h-7 w-9 p-0 text-xs"
                      onClick={() => setRange(r)}
                    >
                      {RANGE_LABELS[r]}
                    </Button>
                  ))}
                </div>
              </div>
            </CardHeader>
            <CardContent className="h-[340px]">
              {historyLoading ? (
                <div className="grid h-full content-end gap-3">
                  <div className="h-9 animate-pulse rounded-md bg-muted/45" />
                  <div className="h-14 animate-pulse rounded-md bg-muted/55" />
                  <div className="h-20 animate-pulse rounded-md bg-muted/70" />
                  <div className="h-28 animate-pulse rounded-md bg-muted/50" />
                </div>
              ) : chartData.length === 0 ? (
                <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border/80 bg-muted/30 px-4 text-center text-sm text-muted-foreground">
                  No review history yet. Refresh records the next snapshot for comparison.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
                    <XAxis
                      dataKey="time"
                      tick={tickStyle}
                      axisLine={false}
                      tickLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      domain={yDomain}
                      padding={{ top: 10, bottom: 10 }}
                      tickFormatter={(v) => {
                        if (chartMode === "return") return `${v.toFixed(1)}%`;
                        // Use compact format only when range is large enough
                        if (yDomain) {
                          const range = yDomain[1] - yDomain[0];
                          if (range < 1000) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
                        }
                        return formatCompactNumber(v);
                      }}
                      tick={tickStyle}
                      axisLine={false}
                      tickLine={false}
                      width={64}
                    />
                    <Tooltip
                      formatter={(value: number | undefined) => {
                        const safeValue = value ?? 0;
                        return chartMode === "return"
                          ? `${safeValue.toFixed(2)}%`
                          : formatCurrency(safeValue);
                      }}
                      contentStyle={tooltipStyle}
                      labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                    />
                    {agentNames
                      .filter((name) => selectedAgents.has(name))
                      .map((name) => (
                        <Line
                          key={name}
                          type="monotone"
                          dataKey={name}
                          stroke={agentColors[name]}
                          strokeWidth={2}
                          dot={false}
                          activeDot={{ r: 4 }}
                          connectNulls
                        />
                      ))}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Prediction benchmark leaderboard */}
          <Card className="border-border/75 hover:border-primary/35 animate-in fade-in-0 duration-300">
            <CardHeader className="gap-3 md:flex-row md:items-center md:justify-between md:space-y-0">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Trophy className="h-4 w-4 text-primary" />
                  Prediction benchmark
                </CardTitle>
                <CardDescription>Brier-based comparison from resolved agent predictions</CardDescription>
              </div>
              <Badge variant="outline">
                {(overview.predictionLeaderboard ?? []).reduce((sum, row) => sum + row.settledPredictions, 0)} settled
              </Badge>
            </CardHeader>
            <CardContent>
              {(overview.predictionLeaderboard ?? []).length === 0 ? (
                <div className="flex min-h-24 items-center justify-center rounded-md border border-dashed border-border/80 bg-muted/30 px-4 text-center text-sm text-muted-foreground">
                  No scored predictions yet. Agents can attach probabilities to orders, and resolved markets will populate this benchmark.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead>
                      <tr className="border-b border-border/70 text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-2 py-2 font-semibold">Rank</th>
                        <th className="px-2 py-2 font-semibold">Agent</th>
                        <th className="px-2 py-2 text-right font-semibold">Avg Brier</th>
                        <th className="px-2 py-2 text-right font-semibold">Settled</th>
                        <th className="px-2 py-2 text-right font-semibold">Submitted</th>
                        <th className="px-2 py-2 text-right font-semibold">Avg edge</th>
                        <th className="px-2 py-2 text-right font-semibold">Avg timing</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(overview.predictionLeaderboard ?? []).slice(0, 8).map((row, index) => (
                        <tr key={row.userId} className="border-b border-border/45 last:border-0">
                          <td className="px-2 py-3 font-mono text-xs text-muted-foreground">#{index + 1}</td>
                          <td className="px-2 py-3">
                            <button
                              type="button"
                              className="text-left font-medium text-foreground hover:text-primary"
                              onClick={() => navigate(`/agents/${row.userId}`)}
                            >
                              {row.userName}
                            </button>
                            <p className="font-mono text-xs text-muted-foreground">{row.userId}</p>
                          </td>
                          <td className="px-2 py-3 text-right font-mono">{formatScore(row.avgBrier)}</td>
                          <td className="px-2 py-3 text-right font-mono">{formatNumber(row.settledPredictions)}</td>
                          <td className="px-2 py-3 text-right font-mono">{formatNumber(row.predictions)}</td>
                          <td className="px-2 py-3 text-right font-mono">{formatSignedPercent(row.avgEdge)}</td>
                          <td className="px-2 py-3 text-right font-mono">{formatHours(row.avgTimeToResolutionHours)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Agent cards grid with search + pagination */}
          <section className="space-y-3 animate-in fade-in-0 duration-300">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold tracking-normal">Agent roster</h2>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-muted-foreground hover:text-foreground"
                    onClick={selectAllAgents}
                  >
                    Show all
                  </Button>
                  <span className="text-border">|</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-muted-foreground hover:text-foreground"
                    onClick={clearAllAgents}
                  >
                    Clear
                  </Button>
                </div>
              </div>
              <div className="relative w-64">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => handleSearch(e.target.value)}
                  placeholder="Search agents..."
                  className="pl-9"
                />
              </div>
            </div>

            {filteredAgents.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center text-sm text-muted-foreground">
                  {search ? "No agents match this review filter." : "No agent accounts are visible yet."}
                </CardContent>
              </Card>
            ) : (
              <>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {pagedAgents.map((agent) => {
                    const isSelected = selectedAgents.has(agent.userName);
                    const agentColor = agentColors[agent.userName];
                    return (
                      <Card
                        key={agent.userId}
                        className={`cursor-pointer transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg overflow-hidden ${isSelected
                          ? "bg-card border-primary/35"
                          : "bg-card/70 border-border/45 opacity-65"
                          }`}
                        onClick={(e) => {
                          if (e.ctrlKey || e.metaKey) {
                            navigate(`/agents/${agent.userId}`);
                          } else {
                            toggleAgent(agent.userName);
                          }
                        }}
                      >
                        <div className="flex">
                          {/* Color bar */}
                          <div
                            className="w-1 shrink-0 transition-opacity duration-200"
                            style={{
                              backgroundColor: agentColor ?? "hsl(var(--border))",
                              opacity: isSelected ? 1 : 0.3,
                            }}
                          />
                          <div className="flex-1 min-w-0">
                            <CardHeader className="pb-2">
                              <div className="flex items-start justify-between">
                                <div className="space-y-0.5">
                                  <CardTitle className="text-lg">{agent.userName}</CardTitle>
                                  <CardDescription className="font-mono text-xs">{agent.userId}</CardDescription>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <Badge variant="outline" className="shrink-0">
                                    {formatNumber(agent.totals.positions)} pos
                                  </Badge>
                                  {agent.valuation.status === "partial" ? (
                                    <Badge variant="outline" className="shrink-0 border-amber-500/40 text-amber-700 dark:text-amber-300">
                                      Partial
                                    </Badge>
                                  ) : null}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      navigate(`/agents/${agent.userId}`);
                                    }}
                                  >
                                    Review
                                  </Button>
                                </div>
                              </div>
                            </CardHeader>
                            <CardContent className="space-y-3">
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <p className="text-xs text-muted-foreground">Paper equity</p>
                                  <p className="text-lg font-semibold">{formatCurrency(agent.totals.equity)}</p>
                                </div>
                                <div>
                                  <p className="text-xs text-muted-foreground">Cash reserve</p>
                                  <p className="text-lg font-semibold">{formatCurrency(agent.balance)}</p>
                                </div>
                              </div>
                              <div className="flex items-center justify-between border-t border-border/50 pt-2">
                                <span className="text-xs text-muted-foreground">Unrealized PnL</span>
                                {agent.totals.unrealizedPnl === null ? (
                                  <span className="font-medium text-muted-foreground">N/A</span>
                                ) : (
                                  <span
                                    className={
                                      agent.totals.unrealizedPnl >= 0
                                        ? "font-medium text-emerald-600 dark:text-emerald-400"
                                        : "font-medium text-rose-600 dark:text-rose-400"
                                    }
                                  >
                                    {formatSignedCurrency(agent.totals.unrealizedPnl)}
                                  </span>
                                )}
                              </div>

                              {/* Top positions preview */}
                              {agent.positions.length > 0 ? (
                                <div className="space-y-1 border-t border-border/50 pt-2">
                                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                    Exposure
                                  </p>
                                  {agent.positions.slice(0, 3).map((pos) => (
                                    <div key={`${pos.market}:${pos.symbol}`} className="flex items-center justify-between text-xs">
                                      <span className="font-mono text-muted-foreground truncate max-w-[140px]">
                                        {pos.symbolName ?? pos.symbol}
                                      </span>
                                      <span className="font-medium">{formatCurrency(pos.marketValue)}</span>
                                    </div>
                                  ))}
                                  {agent.positions.length > 3 ? (
                                    <p className="text-[10px] text-muted-foreground">
                                      +{agent.positions.length - 3} more
                                    </p>
                                  ) : null}
                                </div>
                              ) : null}
                            </CardContent>
                          </div>
                        </div>
                      </Card>
                    );
                  })}
                </div>

                {/* Pagination */}
                {totalPages > 1 ? (
                  <div className="flex items-center justify-between pt-2">
                    <p className="text-xs text-muted-foreground">
                      Showing {safePage * AGENTS_PER_PAGE + 1}–{Math.min((safePage + 1) * AGENTS_PER_PAGE, filteredAgents.length)} of {filteredAgents.length} agents
                    </p>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={safePage === 0}
                        onClick={() => setPage((p) => Math.max(0, p - 1))}
                        className="h-8 w-8 p-0"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      {Array.from({ length: totalPages }, (_, i) => (
                        <Button
                          key={i}
                          variant={i === safePage ? "default" : "outline"}
                          size="sm"
                          onClick={() => setPage(i)}
                          className="h-8 w-8 p-0 text-xs"
                        >
                          {i + 1}
                        </Button>
                      ))}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={safePage >= totalPages - 1}
                        onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                        className="h-8 w-8 p-0"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </>
      ) : (
        <Card>
          <CardContent className="py-16 text-center">
            <p className="text-sm text-muted-foreground">Review overview is not available yet.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

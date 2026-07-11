import type { AgentSeries, AgentView, EquityHistoryResponse, OverviewResponse } from "./dashboard-api";

export type ChartMode = "equity" | "return";
export type ChartRow = Record<string, string | number>;

type AgentWithCompleteValuation = AgentView & {
  totals: AgentView["totals"] & {
    equity: number;
    marketValue: number;
    unrealizedPnl: number;
  };
};

const hasCompleteLiveValuation = (agent: AgentView): agent is AgentWithCompleteValuation =>
  agent.totals.equity !== null
  && agent.totals.marketValue !== null
  && agent.totals.unrealizedPnl !== null;

const sameSnapshotValues = (
  left: AgentSeries["snapshots"][number] | undefined,
  right: AgentSeries["snapshots"][number],
) => Boolean(
  left
  && left.equity === right.equity
  && left.balance === right.balance
  && left.marketValue === right.marketValue
  && left.unrealizedPnl === right.unrealizedPnl,
);

export const mergeEquitySeries = (
  overview: OverviewResponse | null,
  history: EquityHistoryResponse | null,
): AgentSeries[] => {
  const historicalSeries = history?.series ?? [];
  if (!overview) return historicalSeries;

  const historicalByUserId = new Map(historicalSeries.map((series) => [series.userId, series]));
  const merged = overview.agents.map((agent) => {
    const snapshots = [...(historicalByUserId.get(agent.userId)?.snapshots ?? [])];

    if (hasCompleteLiveValuation(agent)) {
      const liveSnapshot = {
        snapshotAt: overview.generatedAt,
        equity: agent.totals.equity,
        balance: agent.balance,
        marketValue: agent.totals.marketValue,
        unrealizedPnl: agent.totals.unrealizedPnl,
      };
      const latestSnapshot = snapshots.at(-1);
      if (latestSnapshot?.snapshotAt !== liveSnapshot.snapshotAt && !sameSnapshotValues(latestSnapshot, liveSnapshot)) {
        snapshots.push(liveSnapshot);
      }
    }

    return { userId: agent.userId, userName: agent.userName, snapshots };
  });

  const liveUserIds = new Set(merged.map((series) => series.userId));
  for (const series of historicalSeries) {
    if (!liveUserIds.has(series.userId)) merged.push(series);
  }

  return merged.filter((series) => series.snapshots.length > 0);
};

export const buildChartRows = (series: AgentSeries[], mode: ChartMode): ChartRow[] => {
  const timestamps = new Set(series.flatMap((agent) => agent.snapshots.map((snapshot) => snapshot.snapshotAt)));
  const orderedTimestamps = [...timestamps].sort();

  const valuesByAgent = new Map<string, Map<string, number>>();
  for (const agent of series) {
    const initialEquity = agent.snapshots[0]?.equity;
    const values = new Map<string, number>();
    for (const snapshot of agent.snapshots) {
      const value = mode === "return"
        ? initialEquity === undefined || initialEquity === 0
          ? 0
          : ((snapshot.equity - initialEquity) / initialEquity) * 100
        : snapshot.equity;
      values.set(snapshot.snapshotAt, Number(value.toFixed(2)));
    }
    valuesByAgent.set(agent.userName, values);
  }

  return orderedTimestamps.map((timestamp) => {
    const row: ChartRow = {
      time: new Date(timestamp).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    };
    for (const agent of series) {
      const value = valuesByAgent.get(agent.userName)?.get(timestamp);
      if (value !== undefined) row[agent.userName] = value;
    }
    return row;
  });
};

export const calculateChartDomain = (
  rows: ChartRow[],
  selectedAgents: ReadonlySet<string>,
): [number, number] | undefined => {
  const values = rows.flatMap((row) => [...selectedAgents]
    .map((name) => row[name])
    .filter((value): value is number => typeof value === "number"));
  if (values.length === 0) return undefined;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min;
  const padding = spread > 0 ? spread * 0.15 : Math.max(Math.abs(max) * 0.05, 1);
  return [min - padding, max + padding];
};

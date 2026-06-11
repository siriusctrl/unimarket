import type { AgentView, OverviewResponse } from "./dashboard-api";

export type { AgentView, MarketView, OverviewResponse, PositionView } from "./dashboard-api";

export type PositionTableRow = {
  id: string;
  userId: string;
  userName: string;
  accountName: string | null;
  market: string;
  symbol: string;
  symbolName: string | null;
  side: string | null;
  quantity: number;
  avgCost: number;
  currentPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
};

export type AgentMixRow = {
  name: string;
  value: number;
};

export type MarketChartRow = {
  name: string;
  value: number;
  pnl: number;
};

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const numberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export const chartPalette = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
  "hsl(var(--chart-6))",
  "hsl(var(--chart-7))",
  "hsl(var(--chart-8))",
];

export const formatCurrency = (value: number | null | undefined): string => {
  if (value === null || value === undefined) {
    return "N/A";
  }

  return currencyFormatter.format(value);
};

export const formatSignedCurrency = (value: number | null | undefined): string => {
  if (value === null || value === undefined) {
    return "N/A";
  }

  const abs = currencyFormatter.format(Math.abs(value));
  if (value > 0) {
    return `+${abs}`;
  }
  if (value < 0) {
    return `-${abs}`;
  }

  return abs;
};

export const formatNumber = (value: number): string => {
  return numberFormatter.format(value);
};

export const formatCompactNumber = (value: number): string => {
  return compactFormatter.format(value);
};

export const formatTooltipCurrency = (value: number | string | undefined): string => {
  if (typeof value !== "number") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return "N/A";
    }
    return currencyFormatter.format(parsed);
  }

  return currencyFormatter.format(value);
};

export const flattenPositions = (overview: OverviewResponse | null): PositionTableRow[] => {
  if (!overview) {
    return [];
  }

  return overview.agents.flatMap((agent) =>
    agent.positions.map((position) => ({
      id: `${agent.userId}:${agent.accountId}:${position.market}:${position.symbol}`,
      userId: agent.userId,
      userName: agent.userName,
      accountName: agent.accountName,
      market: position.market,
      symbol: position.symbol,
      symbolName: position.symbolName ?? null,
      side: position.side ?? null,
      quantity: position.quantity,
      avgCost: position.avgCost,
      currentPrice: position.currentPrice,
      marketValue: position.marketValue,
      unrealizedPnl: position.unrealizedPnl,
    })),
  );
};

export const flattenAgentPositions = (agent: AgentView): PositionTableRow[] => {
  return agent.positions.map((position) => ({
    id: `${agent.userId}:${agent.accountId}:${position.market}:${position.symbol}`,
    userId: agent.userId,
    userName: agent.userName,
    accountName: agent.accountName,
    market: position.market,
    symbol: position.symbol,
    symbolName: position.symbolName ?? null,
    side: position.side ?? null,
    quantity: position.quantity,
    avgCost: position.avgCost,
    currentPrice: position.currentPrice,
    marketValue: position.marketValue,
    unrealizedPnl: position.unrealizedPnl,
  }));
};

export const buildAgentMix = (overview: OverviewResponse | null): AgentMixRow[] => {
  if (!overview) {
    return [];
  }

  const sorted = [...overview.agents]
    .filter((agent) => agent.totals.equity !== null)
    .sort((a, b) => (b.totals.equity ?? Number.NEGATIVE_INFINITY) - (a.totals.equity ?? Number.NEGATIVE_INFINITY))
    .map((agent) => ({ name: agent.userName, value: Number((agent.totals.equity ?? 0).toFixed(6)) }));

  if (sorted.length <= 6) {
    return sorted;
  }

  const topRows = sorted.slice(0, 6);
  const otherEquity = sorted.slice(6).reduce((sum, row) => sum + row.value, 0);

  return [...topRows, { name: "Others", value: Number(otherEquity.toFixed(6)) }];
};

export type PositionView = {
  market: string;
  symbol: string;
  symbolName?: string | null;
  side?: string | null;
  quantity: number;
  avgCost: number;
  currentPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  quoteTimestamp?: string | null;
};

export type AgentView = {
  userId: string;
  userName: string;
  createdAt: string;
  accountId: string | null;
  accountName: string | null;
  balance: number;
  positions: PositionView[];
  totals: {
    positions: number;
    marketValue: number;
    unrealizedPnl: number;
    equity: number;
  };
};

export type MarketView = {
  marketId: string;
  marketName: string;
  users: number;
  positions: number;
  totalQuantity: number;
  totalMarketValue: number;
  totalUnrealizedPnl: number;
  quotedPositions: number;
  unpricedPositions: number;
};

export type OverviewResponse = {
  generatedAt: string;
  totals: {
    users: number;
    positions: number;
    balance: number;
    marketValue: number;
    unrealizedPnl: number;
    equity: number;
  };
  markets: MarketView[];
  agents: AgentView[];
};

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

export const ADMIN_KEY_STORAGE = "unimarket_admin_key";

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

export const readStoredAdminKey = (): string => {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(ADMIN_KEY_STORAGE) ?? "";
};

export const storeAdminKey = (value: string): void => {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(ADMIN_KEY_STORAGE, value);
};

export const clearAdminKey = (): void => {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(ADMIN_KEY_STORAGE);
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
    .sort((a, b) => b.totals.equity - a.totals.equity)
    .map((agent) => ({ name: agent.userName, value: Number(agent.totals.equity.toFixed(6)) }));

  if (sorted.length <= 6) {
    return sorted;
  }

  const topRows = sorted.slice(0, 6);
  const otherEquity = sorted.slice(6).reduce((sum, row) => sum + row.value, 0);

  return [...topRows, { name: "Others", value: Number(otherEquity.toFixed(6)) }];
};

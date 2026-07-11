import type { TimelineEventRecord } from "@unimarket/core";

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

export type ValuationStatus = "complete" | "partial";

export type PortfolioValuationIssue = {
  scope: "position";
  accountId: string;
  market: string;
  symbol: string;
  code: "MARKET_ADAPTER_NOT_FOUND" | "QUOTE_UNAVAILABLE";
  message: string;
};

export type PortfolioValuation = {
  status: ValuationStatus;
  issueCount: number;
  issues: PortfolioValuationIssue[];
  pricedPositions: number;
  unpricedPositions: number;
  knownMarketValue: number;
  knownUnrealizedPnl: number;
};

export type PortfolioValuationSummary = Omit<PortfolioValuation, "issues">;

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
    marketValue: number | null;
    knownMarketValue: number;
    unrealizedPnl: number | null;
    knownUnrealizedPnl: number;
    equity: number | null;
  };
  valuation: PortfolioValuationSummary;
};

export type PredictionLeaderboardRow = {
  userId: string;
  userName: string;
  predictions: number;
  settledPredictions: number;
  avgBrier: number | null;
  avgEdge: number | null;
  avgConviction: number | null;
  avgTimeToResolutionHours: number | null;
};

export type MarketView = {
  marketId: string;
  marketName: string;
  users: number;
  positions: number;
  totalQuantity: number;
  totalMarketValue: number | null;
  knownMarketValue: number;
  totalUnrealizedPnl: number | null;
  knownUnrealizedPnl: number;
  quotedPositions: number;
  unpricedPositions: number;
  valuationStatus: ValuationStatus;
};

export type OverviewResponse = {
  generatedAt: string;
  totals: {
    users: number;
    positions: number;
    balance: number;
    marketValue: number | null;
    knownMarketValue: number;
    unrealizedPnl: number | null;
    knownUnrealizedPnl: number;
    equity: number | null;
  };
  valuation: {
    status: ValuationStatus;
    completeAgents: number;
    partialAgents: number;
    issueCount: number;
    pricedPositions: number;
    unpricedPositions: number;
  };
  markets: MarketView[];
  agents: AgentView[];
  predictionLeaderboard: PredictionLeaderboardRow[];
};

export type FundingDirection = "long_pays_short" | "short_pays_long" | "neutral";

export type EquitySnapshot = {
  snapshotAt: string;
  equity: number;
  balance: number;
  marketValue: number;
  unrealizedPnl: number;
};

export type AgentSeries = {
  userId: string;
  userName: string;
  snapshots: EquitySnapshot[];
};

export type EquityHistoryResponse = {
  range: string;
  series: AgentSeries[];
};

export type TimelineResponse = {
  events: TimelineEventRecord[];
};

const API_UNAVAILABLE_MESSAGE = "API server is unavailable. Start the unimarket API on http://localhost:3100 and refresh.";

export class DashboardApiError extends Error {
  status: number;
  code: string | null;

  constructor(message: string, { status, code = null }: { status: number; code?: string | null }) {
    super(message);
    this.name = "DashboardApiError";
    this.status = status;
    this.code = code;
  }
}

const parseErrorPayload = async (response: Response): Promise<{ message: string; code: string | null }> => {
  try {
    const contentType = response.headers.get("Content-Type") ?? "";
    if (!contentType.includes("application/json")) {
      const text = await response.text();
      return {
        message: text.trim() || (response.status >= 500 ? API_UNAVAILABLE_MESSAGE : `Request failed with status ${response.status}`),
        code: null,
      };
    }

    const payload = await response.json() as { error?: { message?: string; code?: string } };
    return {
      message: payload.error?.message ?? `Request failed with status ${response.status}`,
      code: payload.error?.code ?? null,
    };
  } catch {
    return { message: response.status >= 500 ? API_UNAVAILABLE_MESSAGE : `Request failed with status ${response.status}`, code: null };
  }
};

export const requestJson = async <TResponse>(
  path: string,
  {
    init,
  }: {
    init?: RequestInit;
  } = {},
): Promise<TResponse> => {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, { ...init, headers });

  if (!response.ok) {
    const { message, code } = await parseErrorPayload(response);
    throw new DashboardApiError(message, {
      status: response.status,
      code,
    });
  }

  return await response.json() as TResponse;
};

export const createDashboardApiClient = () => {
  const request = <TResponse>(path: string, init?: RequestInit) => requestJson<TResponse>(path, { init });

  return {
    getOverview: () => request<OverviewResponse>("/api/dashboard/overview"),
    getEquityHistory: (range: string) =>
      request<EquityHistoryResponse>(`/api/dashboard/equity-history?range=${encodeURIComponent(range)}`),
    getUserTimeline: (userId: string, { limit, offset }: { limit: number; offset: number }) =>
      request<TimelineResponse>(`/api/dashboard/users/${userId}/timeline?limit=${limit}&offset=${offset}`),
  };
};

export type DashboardApiClient = ReturnType<typeof createDashboardApiClient>;

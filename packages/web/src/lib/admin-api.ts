import type { TimelineEventRecord } from "@unimarket/core";

import { readStoredAdminKey } from "./admin";

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

const AUTH_ERROR_MESSAGE = "Invalid admin key. Please sign in again.";
const API_UNAVAILABLE_MESSAGE = "API server is unavailable. Start the unimarket API on http://localhost:3100 and refresh.";

export class AdminApiError extends Error {
  status: number;
  code: string | null;
  auth: boolean;

  constructor(message: string, { status, code = null, auth = false }: { status: number; code?: string | null; auth?: boolean }) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.code = code;
    this.auth = auth;
  }
}

export const isAdminAuthError = (error: unknown): error is AdminApiError => {
  return error instanceof AdminApiError && error.auth;
};

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

const requestJson = async <TResponse>(
  path: string,
  {
    adminKey = readStoredAdminKey(),
    onAuthError,
    init,
  }: {
    adminKey?: string;
    onAuthError?: () => void;
    init?: RequestInit;
  } = {},
): Promise<TResponse> => {
  if (!adminKey) {
    throw new AdminApiError("Missing admin key. Please sign in.", { status: 401, auth: true });
  }

  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${adminKey}`);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, { ...init, headers });

  if (!response.ok) {
    const isAuth = response.status === 401 || response.status === 403;
    if (isAuth) {
      onAuthError?.();
    }
    const { message, code } = await parseErrorPayload(response);
    throw new AdminApiError(isAuth ? AUTH_ERROR_MESSAGE : message, {
      status: response.status,
      code,
      auth: isAuth,
    });
  }

  return await response.json() as TResponse;
};

export const createAdminApiClient = ({
  adminKey = readStoredAdminKey(),
  onAuthError,
}: {
  adminKey?: string;
  onAuthError?: () => void;
}) => {
  const request = <TResponse>(path: string, init?: RequestInit) =>
    requestJson<TResponse>(path, { adminKey, onAuthError, init });

  return {
    getOverview: () => request<OverviewResponse>("/api/admin/overview"),
    getEquityHistory: (range: string) =>
      request<EquityHistoryResponse>(`/api/admin/equity-history?range=${encodeURIComponent(range)}`),
    getUserTimeline: (userId: string, { limit, offset }: { limit: number; offset: number }) =>
      request<TimelineResponse>(`/api/admin/users/${userId}/timeline?limit=${limit}&offset=${offset}`),
  };
};

export type AdminApiClient = ReturnType<typeof createAdminApiClient>;

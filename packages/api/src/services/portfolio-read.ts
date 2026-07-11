import {
  calculateMarketValue,
  calculatePerpMaintenanceMargin,
  calculatePerpPositionEquity,
  calculatePerpUnrealizedPnl,
  calculateUnrealizedPnl,
} from "@unimarket/core";
import type { MarketRegistry } from "@unimarket/markets";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { accounts, fundingPayments, orders, perpPositionState, positions } from "../db/schema.js";
import { formatResolvedSymbolLabel, resolveSymbolsByMarketWithCache } from "../symbol-metadata.js";

type AccountRow = typeof accounts.$inferSelect;
type PositionRow = typeof positions.$inferSelect;
type OrderRow = typeof orders.$inferSelect;
type PerpStateRow = typeof perpPositionState.$inferSelect;

export type PortfolioValuationMode = "strict" | "partial";
export type PortfolioValuationStatus = "complete" | "partial";
export type PortfolioValuationIssueCode = "MARKET_ADAPTER_NOT_FOUND" | "QUOTE_UNAVAILABLE";

export type PortfolioValuationIssue = {
  scope: "position";
  accountId: string;
  market: string;
  symbol: string;
  code: PortfolioValuationIssueCode;
  message: string;
};

export type PortfolioValuation = {
  status: PortfolioValuationStatus;
  issueCount: number;
  issues: PortfolioValuationIssue[];
  pricedPositions: number;
  unpricedPositions: number;
  knownMarketValue: number;
  knownUnrealizedPnl: number;
};

export type PortfolioValuationSummary = Omit<PortfolioValuation, "issues">;

export type EnrichedPositionRow = {
  accountId: string;
  market: string;
  symbol: string;
  quantity: number;
  avgCost: number;
  currentPrice: number | null;
  quoteTimestamp: string | null;
  unrealizedPnl: number | null;
  marketValue: number | null;
  accumulatedFunding: number;
  notional: number | null;
  positionEquity: number | null;
  leverage: number | null;
  margin: number | null;
  maintenanceMargin: number | null;
  liquidationPrice: number | null;
};

export type AccountPortfolioModel = {
  accountId: string;
  balance: number;
  positions: EnrichedPositionRow[];
  openOrders: OrderRow[];
  recentOrders: OrderRow[];
  totalValue: number | null;
  totalPnl: number | null;
  totalFunding: number;
  valuation: PortfolioValuation;
};

export type PresentedPortfolioPosition = EnrichedPositionRow & {
  symbolName: string | null;
  side: string | null;
};

export type PresentedPortfolioOrder = OrderRow & {
  symbolName: string | null;
  outcome: string | null;
};

export type PresentedAccountPortfolioModel = Omit<AccountPortfolioModel, "positions" | "openOrders" | "recentOrders"> & {
  positions: PresentedPortfolioPosition[];
  openOrders: PresentedPortfolioOrder[];
  recentOrders: PresentedPortfolioOrder[];
};

const finalizeAccountPortfolioModel = ({
  account,
  positions,
  issues,
  openOrders = [],
  recentOrders = [],
}: {
  account: AccountRow;
  positions: EnrichedPositionRow[];
  issues: PortfolioValuationIssue[];
  openOrders?: OrderRow[];
  recentOrders?: OrderRow[];
}): AccountPortfolioModel => {
  const knownMarketValue = Number(positions.reduce((sum, row) => sum + (row.marketValue ?? 0), 0).toFixed(6));
  const knownUnrealizedPnl = Number(positions.reduce((sum, row) => sum + (row.unrealizedPnl ?? 0), 0).toFixed(6));
  const unpricedPositions = positions.filter((row) => row.marketValue === null || row.unrealizedPnl === null).length;
  const pricedPositions = positions.length - unpricedPositions;
  const totalFunding = positions.reduce((sum, row) => sum + row.accumulatedFunding, 0);
  const valuationStatus: PortfolioValuationStatus = issues.length > 0 || unpricedPositions > 0 ? "partial" : "complete";
  const totalValue = valuationStatus === "complete" ? Number((account.balance + knownMarketValue).toFixed(6)) : null;
  const totalPnl = valuationStatus === "complete" ? knownUnrealizedPnl : null;

  return {
    accountId: account.id,
    balance: account.balance,
    positions,
    openOrders,
    recentOrders,
    totalValue,
    totalPnl,
    totalFunding: Number(totalFunding.toFixed(6)),
    valuation: {
      status: valuationStatus,
      issueCount: issues.length,
      issues,
      pricedPositions,
      unpricedPositions,
      knownMarketValue,
      knownUnrealizedPnl,
    },
  };
};

const loadFundingByAccountAndSymbol = async (accountIds: string[]): Promise<Map<string, number>> => {
  if (accountIds.length === 0) {
    return new Map();
  }

  const fundingSums = await db
    .select({
      accountId: fundingPayments.accountId,
      market: fundingPayments.market,
      symbol: fundingPayments.symbol,
      total: sql<number>`sum(${fundingPayments.payment})`.as("total"),
    })
    .from(fundingPayments)
    .where(accountIds.length === 1 ? eq(fundingPayments.accountId, accountIds[0]!) : inArray(fundingPayments.accountId, accountIds))
    .groupBy(fundingPayments.accountId, fundingPayments.market, fundingPayments.symbol)
    .all();

  const fundingByKey = new Map<string, number>();
  for (const row of fundingSums) {
    fundingByKey.set(`${row.accountId}:${row.market}:${row.symbol}`, Number((row.total ?? 0).toFixed(6)));
  }
  return fundingByKey;
};

const collectSymbolsByMarket = (
  portfolio: AccountPortfolioModel,
): Map<string, Set<string>> => {
  const symbolsByMarket = new Map<string, Set<string>>();
  const append = (market: string, symbol: string): void => {
    const current = symbolsByMarket.get(market);
    if (current) {
      current.add(symbol);
    } else {
      symbolsByMarket.set(market, new Set([symbol]));
    }
  };

  for (const position of portfolio.positions) {
    append(position.market, position.symbol);
  }
  for (const order of portfolio.openOrders) {
    append(order.market, order.symbol);
  }
  for (const order of portfolio.recentOrders) {
    append(order.market, order.symbol);
  }

  return symbolsByMarket;
};

type QuoteLookup =
  | { kind: "priced"; price: number; timestamp: string | null }
  | { kind: "missing_adapter"; message: string }
  | { kind: "quote_failed"; message: string };

const enrichPositions = async ({
  registry,
  rows,
  perpStateByPositionId,
  fundingByKey,
  valuationMode,
}: {
  registry: MarketRegistry;
  rows: PositionRow[];
  perpStateByPositionId: Map<string, PerpStateRow>;
  fundingByKey: Map<string, number>;
  valuationMode: PortfolioValuationMode;
}): Promise<{ positions: EnrichedPositionRow[]; issues: PortfolioValuationIssue[] }> => {
  const quoteByKey = new Map<string, QuoteLookup>();

  for (const row of rows) {
    const key = `${row.market}:${row.symbol}`;
    if (quoteByKey.has(key)) continue;

    const adapter = registry.get(row.market);
    if (!adapter) {
      quoteByKey.set(key, {
        kind: "missing_adapter",
        message: `Market adapter not found for ${row.market}`,
      });
      continue;
    }

    try {
      const quote = await adapter.getQuote(row.symbol);
      quoteByKey.set(key, {
        kind: "priced",
        price: quote.price,
        timestamp: quote.timestamp ?? null,
      });
    } catch (error) {
      const rawMessage = error instanceof Error && error.message
        ? error.message
        : "Unknown quote lookup failure";
      quoteByKey.set(key, {
        kind: "quote_failed",
        message: `Quote lookup failed for ${row.market}:${row.symbol}: ${rawMessage}`,
      });
    }
  }

  const enriched: EnrichedPositionRow[] = [];
  const issues: PortfolioValuationIssue[] = [];

  for (const row of rows) {
    const key = `${row.market}:${row.symbol}`;
    const adapter = registry.get(row.market);
    const quoteLookup = quoteByKey.get(key);

    if (!quoteLookup) {
      throw new Error(`Missing quote lookup state for ${row.market}:${row.symbol}`);
    }

    if (valuationMode === "strict" && quoteLookup.kind !== "priced") {
      throw new Error(quoteLookup.message);
    }

    if (quoteLookup.kind !== "priced") {
      issues.push({
        scope: "position",
        accountId: row.accountId,
        market: row.market,
        symbol: row.symbol,
        code: quoteLookup.kind === "missing_adapter" ? "MARKET_ADAPTER_NOT_FOUND" : "QUOTE_UNAVAILABLE",
        message: quoteLookup.message,
      });
    }

    const perpState = perpStateByPositionId.get(row.id);
    const isPerp = Boolean(adapter?.getFundingRate && perpState);
    const currentPrice = quoteLookup.kind === "priced" ? quoteLookup.price : null;
    const quoteTimestamp = quoteLookup.kind === "priced" ? quoteLookup.timestamp : null;
    const unrealizedPnl = currentPrice === null
      ? null
      : isPerp
        ? calculatePerpUnrealizedPnl({ quantity: row.quantity, avgCost: row.avgCost }, currentPrice)
        : calculateUnrealizedPnl({ quantity: row.quantity, avgCost: row.avgCost }, currentPrice);
    const positionEquity = currentPrice === null || !isPerp || !perpState
      ? null
      : calculatePerpPositionEquity(
        { quantity: row.quantity, avgCost: row.avgCost, margin: perpState.margin },
        currentPrice,
      );
    const maintenanceMargin = currentPrice === null || !isPerp || !perpState
      ? null
      : calculatePerpMaintenanceMargin(
        { quantity: row.quantity, maintenanceMarginRatio: perpState.maintenanceMarginRatio },
        currentPrice,
      );
    const marketValue = currentPrice === null
      ? null
      : isPerp
        ? positionEquity
        : calculateMarketValue({ quantity: row.quantity, avgCost: row.avgCost }, currentPrice);

    enriched.push({
      accountId: row.accountId,
      market: row.market,
      symbol: row.symbol,
      quantity: row.quantity,
      avgCost: row.avgCost,
      currentPrice,
      quoteTimestamp,
      unrealizedPnl,
      marketValue,
      accumulatedFunding: fundingByKey.get(`${row.accountId}:${row.market}:${row.symbol}`) ?? 0,
      notional: currentPrice === null || !isPerp ? null : Number((Math.abs(row.quantity) * currentPrice).toFixed(6)),
      positionEquity,
      leverage: perpState?.leverage ?? null,
      margin: perpState?.margin ?? null,
      maintenanceMargin,
      liquidationPrice: perpState?.liquidationPrice ?? null,
    });
  }

  return { positions: enriched, issues };
};

export const buildAccountPortfolioModel = async ({
  account,
  registry,
  includeRecentOrders = false,
  valuationMode = "partial",
}: {
  account: AccountRow;
  registry: MarketRegistry;
  includeRecentOrders?: boolean;
  valuationMode?: PortfolioValuationMode;
}): Promise<AccountPortfolioModel> => {
  const [positionRows, openOrders, recentOrders, perpStateRows, fundingByKey] = await Promise.all([
    db.select().from(positions).where(eq(positions.accountId, account.id)).all(),
    db
      .select()
      .from(orders)
      .where(and(eq(orders.accountId, account.id), eq(orders.status, "pending")))
      .orderBy(desc(orders.createdAt))
      .all(),
    includeRecentOrders
      ? db.select().from(orders).where(eq(orders.accountId, account.id)).orderBy(desc(orders.createdAt)).limit(20).all()
      : Promise.resolve([] as OrderRow[]),
    db.select().from(perpPositionState).where(eq(perpPositionState.accountId, account.id)).all(),
    loadFundingByAccountAndSymbol([account.id]),
  ]);

  const perpStateByPositionId = new Map(perpStateRows.map((row) => [row.positionId, row]));
  const { positions: positionsView, issues } = await enrichPositions({
    registry,
    rows: positionRows,
    perpStateByPositionId,
    fundingByKey,
    valuationMode,
  });
  return finalizeAccountPortfolioModel({
    account,
    positions: positionsView,
    issues,
    openOrders,
    recentOrders,
  });
};

export const presentAccountPortfolioModel = async ({
  portfolio,
  registry,
}: {
  portfolio: AccountPortfolioModel;
  registry: MarketRegistry;
}): Promise<PresentedAccountPortfolioModel> => {
  const symbolResolutionByMarket = await resolveSymbolsByMarketWithCache(
    registry,
    collectSymbolsByMarket(portfolio),
  );

  const presentPosition = (position: EnrichedPositionRow): PresentedPortfolioPosition => {
    const resolution = symbolResolutionByMarket.get(position.market);
    return {
      ...position,
      symbolName: formatResolvedSymbolLabel(resolution, position.symbol),
      side: resolution?.outcomes.get(position.symbol) ?? null,
    };
  };

  const presentOrder = (order: OrderRow): PresentedPortfolioOrder => {
    const resolution = symbolResolutionByMarket.get(order.market);
    return {
      ...order,
      symbolName: formatResolvedSymbolLabel(resolution, order.symbol),
      outcome: resolution?.outcomes.get(order.symbol) ?? null,
    };
  };

  return {
    ...portfolio,
    positions: portfolio.positions.map(presentPosition),
    openOrders: portfolio.openOrders.map(presentOrder),
    recentOrders: portfolio.recentOrders.map(presentOrder),
  };
};

export const buildAccountPortfolioModelsByAccount = async ({
  accounts: accountRows,
  registry,
  valuationMode = "partial",
}: {
  accounts: AccountRow[];
  registry: MarketRegistry;
  valuationMode?: PortfolioValuationMode;
}): Promise<Map<string, AccountPortfolioModel>> => {
  if (accountRows.length === 0) {
    return new Map();
  }

  const accountIds = accountRows.map((account) => account.id);
  const [positionRows, perpStateRows, fundingByKey] = await Promise.all([
    db.select().from(positions).where(inArray(positions.accountId, accountIds)).all(),
    db.select().from(perpPositionState).where(inArray(perpPositionState.accountId, accountIds)).all(),
    loadFundingByAccountAndSymbol(accountIds),
  ]);

  const perpStateByPositionId = new Map(perpStateRows.map((row) => [row.positionId, row]));
  const { positions: positionsView, issues } = await enrichPositions({
    registry,
    rows: positionRows,
    perpStateByPositionId,
    fundingByKey,
    valuationMode,
  });

  const positionsByAccountId = new Map<string, EnrichedPositionRow[]>();
  for (const position of positionsView) {
    const grouped = positionsByAccountId.get(position.accountId);
    if (grouped) {
      grouped.push(position);
    } else {
      positionsByAccountId.set(position.accountId, [position]);
    }
  }

  const issuesByAccountId = new Map<string, PortfolioValuationIssue[]>();
  for (const issue of issues) {
    const current = issuesByAccountId.get(issue.accountId);
    if (current) {
      current.push(issue);
    } else {
      issuesByAccountId.set(issue.accountId, [issue]);
    }
  }

  const portfolioByAccountId = new Map<string, AccountPortfolioModel>();
  for (const account of accountRows) {
    portfolioByAccountId.set(
      account.id,
      finalizeAccountPortfolioModel({
        account,
        positions: positionsByAccountId.get(account.id) ?? [],
        issues: issuesByAccountId.get(account.id) ?? [],
      }),
    );
  }

  return portfolioByAccountId;
};

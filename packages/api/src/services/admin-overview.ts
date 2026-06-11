import { and, gte, inArray } from "drizzle-orm";
import type { MarketRegistry } from "@unimarket/markets";

import { db } from "../db/client.js";
import { accounts, equitySnapshots, positions, users } from "../db/schema.js";
import { formatResolvedSymbolLabel, resolveSymbolsByMarketWithCache } from "../symbol-metadata.js";
import { makeId, nowIso } from "../utils.js";
import { buildAccountPortfolioModelsByAccount, type AccountPortfolioModel, type PortfolioValuationSummary } from "./portfolio-read.js";
import { buildPredictionLeaderboard, type PredictionLeaderboardRow } from "./prediction-scoring.js";

type UserRow = typeof users.$inferSelect;
type AccountRow = typeof accounts.$inferSelect;

export type AdminOverviewAgent = {
  userId: string;
  userName: string;
  createdAt: string;
  accountId: string | null;
  accountName: string | null;
  balance: number;
  positions: Array<{
    market: string;
    symbol: string;
    symbolName: string | null;
    side: string | null;
    quantity: number;
    avgCost: number;
    currentPrice: number | null;
    marketValue: number | null;
    unrealizedPnl: number | null;
    quoteTimestamp: string | null;
    margin: number | null;
    maintenanceMargin: number | null;
    leverage: number | null;
    liquidationPrice: number | null;
  }>;
  totals: {
    positions: number;
    balance: number;
    marketValue: number | null;
    knownMarketValue: number;
    unrealizedPnl: number | null;
    knownUnrealizedPnl: number;
    equity: number | null;
  };
  valuation: PortfolioValuationSummary;
};

export type AdminOverviewModel = {
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
    status: "complete" | "partial";
    completeAgents: number;
    partialAgents: number;
    issueCount: number;
    pricedPositions: number;
    unpricedPositions: number;
  };
  markets: Array<{
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
    valuationStatus: "complete" | "partial";
  }>;
  agents: AdminOverviewAgent[];
  predictionLeaderboard: PredictionLeaderboardRow[];
};

const getPrimaryAccountByUserId = (accountRows: AccountRow[]): Map<string, AccountRow> => {
  const primaryAccountByUserId = new Map<string, AccountRow>();
  for (const account of [...accountRows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (!primaryAccountByUserId.has(account.userId)) {
      primaryAccountByUserId.set(account.userId, account);
    }
  }
  return primaryAccountByUserId;
};

const toValuationSummary = (portfolio: AccountPortfolioModel | null | undefined): PortfolioValuationSummary => {
  if (!portfolio) {
    return {
      status: "complete",
      issueCount: 0,
      pricedPositions: 0,
      unpricedPositions: 0,
      knownMarketValue: 0,
      knownUnrealizedPnl: 0,
    };
  }

  const { issues: _ignoredIssues, ...summary } = portfolio.valuation;
  return summary;
};

const sortNullableDescending = (left: number | null, right: number | null): number => {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
};

export const buildAdminOverviewModel = async ({
  registry,
  includeSymbolMetadata = true,
}: {
  registry: MarketRegistry;
  includeSymbolMetadata?: boolean;
}): Promise<AdminOverviewModel> => {
  const [userRows, accountRows, positionRows] = await Promise.all([
    db.select().from(users).all(),
    db.select().from(accounts).all(),
    db.select().from(positions).all(),
  ]);
  const predictionLeaderboard = await buildPredictionLeaderboard();
  const portfolioByAccountId = await buildAccountPortfolioModelsByAccount({ accounts: accountRows, registry });

  const primaryAccountByUserId = getPrimaryAccountByUserId(accountRows);
  const symbolsByMarket = new Map<string, Set<string>>();
  if (includeSymbolMetadata) {
    for (const portfolio of portfolioByAccountId.values()) {
      for (const position of portfolio.positions) {
        const current = symbolsByMarket.get(position.market);
        if (current) {
          current.add(position.symbol);
        } else {
          symbolsByMarket.set(position.market, new Set([position.symbol]));
        }
      }
    }
  }

  const symbolResolutionByMarket = includeSymbolMetadata
    ? await resolveSymbolsByMarketWithCache(registry, symbolsByMarket)
    : new Map();

  const marketSummaryById = new Map<string, {
    marketId: string;
    marketName: string;
    users: Set<string>;
    positions: number;
    totalQuantity: number;
    knownMarketValue: number;
    knownUnrealizedPnl: number;
    quotedPositions: number;
    unpricedPositions: number;
  }>();

  for (const portfolio of portfolioByAccountId.values()) {
    const account = accountRows.find((row) => row.id === portfolio.accountId);
    for (const position of portfolio.positions) {
      if (!marketSummaryById.has(position.market)) {
        marketSummaryById.set(position.market, {
          marketId: position.market,
          marketName: registry.get(position.market)?.displayName ?? position.market,
          users: new Set<string>(),
          positions: 0,
          totalQuantity: 0,
          knownMarketValue: 0,
          knownUnrealizedPnl: 0,
          quotedPositions: 0,
          unpricedPositions: 0,
        });
      }

      const marketSummary = marketSummaryById.get(position.market)!;
      marketSummary.positions += 1;
      marketSummary.totalQuantity += position.quantity;
      if (account) {
        marketSummary.users.add(account.userId);
      }

      if (position.marketValue === null || position.unrealizedPnl === null) {
        marketSummary.unpricedPositions += 1;
      } else {
        marketSummary.quotedPositions += 1;
        marketSummary.knownMarketValue += position.marketValue;
        marketSummary.knownUnrealizedPnl += position.unrealizedPnl;
      }
    }
  }

  const agents = userRows
    .map<AdminOverviewAgent>((user) => {
      const primaryAccount = primaryAccountByUserId.get(user.id) ?? null;
      const portfolio = primaryAccount ? portfolioByAccountId.get(primaryAccount.id) : null;
      const valuation = toValuationSummary(portfolio);
      const agentPositions = [...(portfolio?.positions ?? [])]
        .map((position) => {
          const resolution = symbolResolutionByMarket.get(position.market);
          return {
            market: position.market,
            symbol: position.symbol,
            symbolName: includeSymbolMetadata ? formatResolvedSymbolLabel(resolution, position.symbol) : null,
            side: includeSymbolMetadata ? (resolution?.outcomes.get(position.symbol) ?? null) : null,
            quantity: position.quantity,
            avgCost: position.avgCost,
            currentPrice: position.currentPrice,
            marketValue: position.marketValue,
            unrealizedPnl: position.unrealizedPnl,
            quoteTimestamp: position.quoteTimestamp,
            margin: position.margin,
            maintenanceMargin: position.maintenanceMargin,
            leverage: position.leverage,
            liquidationPrice: position.liquidationPrice,
          };
        })
        .sort((a, b) => `${a.market}:${a.symbol}`.localeCompare(`${b.market}:${b.symbol}`));

      const totalBalance = Number((primaryAccount?.balance ?? 0).toFixed(6));
      const totalMarketValue = valuation.status === "complete" ? valuation.knownMarketValue : null;
      const totalUnrealizedPnl = valuation.status === "complete" ? valuation.knownUnrealizedPnl : null;
      const totalEquity = portfolio?.totalValue ?? (valuation.status === "complete" ? totalBalance : null);

      return {
        userId: user.id,
        userName: user.name,
        createdAt: user.createdAt,
        accountId: primaryAccount?.id ?? null,
        accountName: primaryAccount?.name ?? null,
        balance: totalBalance,
        positions: agentPositions,
        totals: {
          positions: agentPositions.length,
          balance: totalBalance,
          marketValue: totalMarketValue,
          knownMarketValue: valuation.knownMarketValue,
          unrealizedPnl: totalUnrealizedPnl,
          knownUnrealizedPnl: valuation.knownUnrealizedPnl,
          equity: totalEquity,
        },
        valuation,
      };
    })
    .sort((a, b) => {
      const byEquity = sortNullableDescending(a.totals.equity, b.totals.equity);
      if (byEquity !== 0) return byEquity;
      return b.totals.knownMarketValue - a.totals.knownMarketValue;
    });

  const markets = Array.from(marketSummaryById.values())
    .map((market) => ({
      marketId: market.marketId,
      marketName: market.marketName,
      users: market.users.size,
      positions: market.positions,
      totalQuantity: market.totalQuantity,
      totalMarketValue: market.unpricedPositions === 0 ? Number(market.knownMarketValue.toFixed(6)) : null,
      knownMarketValue: Number(market.knownMarketValue.toFixed(6)),
      totalUnrealizedPnl: market.unpricedPositions === 0 ? Number(market.knownUnrealizedPnl.toFixed(6)) : null,
      knownUnrealizedPnl: Number(market.knownUnrealizedPnl.toFixed(6)),
      quotedPositions: market.quotedPositions,
      unpricedPositions: market.unpricedPositions,
      valuationStatus: market.unpricedPositions > 0 ? ("partial" as const) : ("complete" as const),
    }))
    .sort((a, b) => b.knownMarketValue - a.knownMarketValue);

  const totalBalance = Number(agents.reduce((sum, agent) => sum + agent.totals.balance, 0).toFixed(6));
  const knownMarketValue = Number(markets.reduce((sum, market) => sum + market.knownMarketValue, 0).toFixed(6));
  const knownUnrealizedPnl = Number(markets.reduce((sum, market) => sum + market.knownUnrealizedPnl, 0).toFixed(6));
  const partialAgents = agents.filter((agent) => agent.valuation.status === "partial").length;
  const completeAgents = agents.length - partialAgents;
  const issueCount = Array.from(portfolioByAccountId.values()).reduce((sum, portfolio) => sum + portfolio.valuation.issueCount, 0);
  const pricedPositions = Array.from(portfolioByAccountId.values()).reduce((sum, portfolio) => sum + portfolio.valuation.pricedPositions, 0);
  const unpricedPositions = Array.from(portfolioByAccountId.values()).reduce((sum, portfolio) => sum + portfolio.valuation.unpricedPositions, 0);
  const valuationStatus = partialAgents > 0 || unpricedPositions > 0 ? "partial" : "complete";

  return {
    generatedAt: nowIso(),
    totals: {
      users: userRows.length,
      positions: positionRows.length,
      balance: totalBalance,
      marketValue: valuationStatus === "complete" ? knownMarketValue : null,
      knownMarketValue,
      unrealizedPnl: valuationStatus === "complete" ? knownUnrealizedPnl : null,
      knownUnrealizedPnl,
      equity: valuationStatus === "complete" ? Number((totalBalance + knownMarketValue).toFixed(6)) : null,
    },
    valuation: {
      status: valuationStatus,
      completeAgents,
      partialAgents,
      issueCount,
      pricedPositions,
      unpricedPositions,
    },
    markets,
    agents,
    predictionLeaderboard,
  };
};

export const recordEquitySnapshotsFromOverview = async ({
  overview,
  windowMs = 5 * 60_000,
}: {
  overview: AdminOverviewModel;
  windowMs?: number;
}): Promise<{ created: number; skipped: number }> => {
  if (overview.agents.length === 0) {
    return { created: 0, skipped: 0 };
  }

  const userIds = overview.agents.map((agent) => agent.userId);
  const since = new Date(Date.now() - windowMs).toISOString();
  const recentRows = await db
    .select({ userId: equitySnapshots.userId })
    .from(equitySnapshots)
    .where(and(inArray(equitySnapshots.userId, userIds), gte(equitySnapshots.snapshotAt, since)))
    .all();
  const recentlySnapshottedUserIds = new Set(recentRows.map((row) => row.userId));

  const pendingSnapshots = overview.agents
    .filter((agent) => !recentlySnapshottedUserIds.has(agent.userId))
    .filter((agent) => agent.totals.marketValue !== null && agent.totals.equity !== null && agent.totals.unrealizedPnl !== null)
    .map((agent) => ({
      id: makeId("snap"),
      userId: agent.userId,
      balance: agent.totals.balance,
      marketValue: agent.totals.marketValue!,
      equity: agent.totals.equity!,
      unrealizedPnl: agent.totals.unrealizedPnl!,
      snapshotAt: overview.generatedAt,
    }));

  if (pendingSnapshots.length === 0) {
    return { created: 0, skipped: overview.agents.length };
  }

  await db.insert(equitySnapshots).values(pendingSnapshots).run();
  return { created: pendingSnapshots.length, skipped: overview.agents.length - pendingSnapshots.length };
};

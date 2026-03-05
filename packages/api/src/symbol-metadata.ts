import type { MarketRegistry, SymbolResolution } from "@unimarket/markets";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "./db/client.js";
import { symbolMetadataCache } from "./db/schema.js";

const parsePositiveMs = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const CACHE_TTL_MS = parsePositiveMs(process.env.SYMBOL_METADATA_TTL_MS, 24 * 60 * 60 * 1000);
const MISS_TTL_MS = parsePositiveMs(process.env.SYMBOL_METADATA_MISS_TTL_MS, 10 * 60 * 1000);

const createEmptyResolution = (): SymbolResolution => ({ names: new Map(), outcomes: new Map() });

const describeError = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  return "symbol metadata fetch failed";
};

const mergeResolution = (target: SymbolResolution, incoming: SymbolResolution): void => {
  for (const [symbol, name] of incoming.names) {
    target.names.set(symbol, name);
  }
  for (const [symbol, outcome] of incoming.outcomes) {
    target.outcomes.set(symbol, outcome);
  }
};

const applyCacheRow = (
  target: SymbolResolution,
  row: {
    symbol: string;
    symbolName: string | null;
    outcome: string | null;
  },
): void => {
  if (row.symbolName) target.names.set(row.symbol, row.symbolName);
  if (row.outcome) target.outcomes.set(row.symbol, row.outcome);
};

const isResolved = (resolution: SymbolResolution, symbol: string): boolean => {
  return resolution.names.has(symbol) || resolution.outcomes.has(symbol);
};

const persistCacheRows = async (
  rows: Array<{
    market: string;
    symbol: string;
    symbolName: string | null;
    outcome: string | null;
    fetchedAt: string;
    expiresAt: string;
    lastError: string | null;
  }>,
): Promise<void> => {
  await db.transaction(async (tx) => {
    for (const row of rows) {
      await tx
        .insert(symbolMetadataCache)
        .values(row)
        .onConflictDoUpdate({
          target: [symbolMetadataCache.market, symbolMetadataCache.symbol],
          set: {
            symbolName: row.symbolName,
            outcome: row.outcome,
            fetchedAt: row.fetchedAt,
            expiresAt: row.expiresAt,
            lastError: row.lastError,
          },
        })
        .run();
    }
  });
};

export const resolveSymbolsWithCache = async (
  registry: MarketRegistry,
  marketId: string,
  symbols: Iterable<string>,
): Promise<SymbolResolution> => {
  const symbolList = [...new Set(Array.from(symbols).map((item) => item.trim()).filter((item) => item.length > 0))];
  if (symbolList.length === 0) return createEmptyResolution();

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const resolution = createEmptyResolution();

  const cachedRows = await db
    .select()
    .from(symbolMetadataCache)
    .where(and(eq(symbolMetadataCache.market, marketId), inArray(symbolMetadataCache.symbol, symbolList)))
    .all();

  const staleRowsBySymbol = new Map<string, { symbol: string; symbolName: string | null; outcome: string | null }>();
  const freshSymbols = new Set<string>();

  for (const row of cachedRows) {
    const hasMetadata = row.symbolName !== null || row.outcome !== null;
    if (row.expiresAt > now && hasMetadata) {
      applyCacheRow(resolution, row);
      freshSymbols.add(row.symbol);
    } else {
      staleRowsBySymbol.set(row.symbol, row);
    }
  }

  const unresolvedSymbols = symbolList.filter((symbol) => !freshSymbols.has(symbol));
  if (unresolvedSymbols.length === 0) {
    return resolution;
  }

  const adapter = registry.get(marketId);
  const resolver = adapter?.resolveSymbolNames;
  const fetchErrorBySymbol = new Map<string, string>();
  let bulkFailed = false;

  if (typeof resolver === "function") {
    try {
      const resolved = await resolver.call(adapter, unresolvedSymbols);
      mergeResolution(resolution, resolved);
    } catch (error) {
      bulkFailed = true;
      const message = describeError(error);
      console.warn(
        `[symbol-metadata] bulk resolution failed for market=${marketId} symbols=${unresolvedSymbols.length}: ${message}`,
      );
      for (const symbol of unresolvedSymbols) {
        fetchErrorBySymbol.set(symbol, message);
      }
    }

    if (bulkFailed) {
      // Fall back to single-symbol lookups only when bulk resolution itself fails.
      for (const symbol of unresolvedSymbols) {
        if (isResolved(resolution, symbol)) continue;
        try {
          const single = await resolver.call(adapter, [symbol]);
          mergeResolution(resolution, single);
          if (!isResolved(resolution, symbol)) {
            fetchErrorBySymbol.set(symbol, fetchErrorBySymbol.get(symbol) ?? "symbol metadata unavailable");
          }
        } catch (error) {
          const message = describeError(error);
          fetchErrorBySymbol.set(symbol, message);
        }
      }
    } else {
      for (const symbol of unresolvedSymbols) {
        if (!isResolved(resolution, symbol)) {
          fetchErrorBySymbol.set(symbol, fetchErrorBySymbol.get(symbol) ?? "symbol metadata unavailable");
        }
      }
    }
  } else {
    for (const symbol of unresolvedSymbols) {
      fetchErrorBySymbol.set(symbol, "adapter does not support symbol resolution");
    }
  }

  // Reuse stale metadata when upstream resolution fails.
  for (const symbol of unresolvedSymbols) {
    if (isResolved(resolution, symbol)) continue;
    const stale = staleRowsBySymbol.get(symbol);
    if (!stale) continue;
    applyCacheRow(resolution, stale);
  }

  const pendingRows = unresolvedSymbols.map((symbol) => {
    const symbolName = resolution.names.get(symbol) ?? null;
    const outcome = resolution.outcomes.get(symbol) ?? null;
    const hasMetadata = symbolName !== null || outcome !== null;
    const ttlMs = hasMetadata ? CACHE_TTL_MS : MISS_TTL_MS;
    return {
      market: marketId,
      symbol,
      symbolName,
      outcome,
      fetchedAt: now,
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
      lastError: hasMetadata ? null : (fetchErrorBySymbol.get(symbol) ?? "symbol metadata unavailable"),
    };
  });

  try {
    await persistCacheRows(pendingRows);
  } catch (error) {
    console.warn(`[symbol-metadata] cache write failed for market=${marketId}`, error);
  }

  return resolution;
};

import { multiQuoteQuerySchema, quoteQuerySchema, searchMarketQuerySchema } from "@unimarket/core";
import { MarketAdapterError, type MarketRegistry, type TradingConstraints } from "@unimarket/markets";
import { Hono } from "hono";

import type { AppVariables } from "../auth.js";
import { jsonError } from "../errors.js";
import { parseQuery, withErrorHandling } from "../helpers.js";

export const createMarketRoutes = (registry: MarketRegistry) => {
  const router = new Hono<{ Variables: AppVariables }>();
  const defaultTradingConstraints: TradingConstraints = {
    minQuantity: 1,
    quantityStep: 1,
    supportsFractional: false,
    maxLeverage: null,
  };

  const toBatchError = (error: unknown): { code: string; message: string } => {
    if (error instanceof MarketAdapterError) {
      return { code: error.code, message: error.message };
    }
    if (error instanceof Error) {
      return { code: "INTERNAL_ERROR", message: error.message };
    }
    return { code: "INTERNAL_ERROR", message: "Unknown server error" };
  };

  const normalizeSymbol = async (adapter: { normalizeSymbol?: (symbol: string) => Promise<string> }, symbol: string): Promise<string> => {
    if (typeof adapter.normalizeSymbol !== "function") return symbol;
    return adapter.normalizeSymbol(symbol);
  };

  router.get(
    "/",
    withErrorHandling(async (c) => {
      return c.json({ markets: registry.list() });
    }),
  );

  router.get(
    "/:market/search",
    withErrorHandling(async (c) => {
      const parsed = parseQuery(c, searchMarketQuerySchema);
      if (!parsed.success) return parsed.response;

      const adapter = registry.get(c.req.param("market"));
      if (!adapter) return jsonError(c, 404, "MARKET_NOT_FOUND", "Market not found");
      if (!adapter.capabilities.includes("search")) {
        return jsonError(c, 400, "CAPABILITY_NOT_SUPPORTED", "search is not supported for this market");
      }

      const results = await adapter.search(parsed.data.q ?? "", {
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
      return c.json({ results });
    }),
  );

  router.get(
    "/:market/trading-constraints",
    withErrorHandling(async (c) => {
      const parsed = parseQuery(c, quoteQuerySchema);
      if (!parsed.success) return parsed.response;

      const adapter = registry.get(c.req.param("market"));
      if (!adapter) return jsonError(c, 404, "MARKET_NOT_FOUND", "Market not found");

      const symbol = await normalizeSymbol(adapter, parsed.data.symbol);
      const constraints =
        typeof adapter.getTradingConstraints === "function"
          ? await adapter.getTradingConstraints(symbol)
          : defaultTradingConstraints;
      return c.json({
        symbol,
        constraints: {
          minQuantity: constraints.minQuantity,
          quantityStep: constraints.quantityStep,
          supportsFractional: constraints.supportsFractional,
          maxLeverage: constraints.maxLeverage ?? null,
        },
      });
    }),
  );

  router.get(
    "/:market/quote",
    withErrorHandling(async (c) => {
      const parsed = parseQuery(c, quoteQuerySchema);
      if (!parsed.success) return parsed.response;

      const adapter = registry.get(c.req.param("market"));
      if (!adapter) return jsonError(c, 404, "MARKET_NOT_FOUND", "Market not found");
      if (!adapter.capabilities.includes("quote")) {
        return jsonError(c, 400, "CAPABILITY_NOT_SUPPORTED", "quote is not supported for this market");
      }

      const symbol = await normalizeSymbol(adapter, parsed.data.symbol);
      const quote = await adapter.getQuote(symbol);
      return c.json(quote);
    }),
  );

  router.get(
    "/:market/quotes",
    withErrorHandling(async (c) => {
      const parsed = parseQuery(c, multiQuoteQuerySchema);
      if (!parsed.success) return parsed.response;

      const adapter = registry.get(c.req.param("market"));
      if (!adapter) return jsonError(c, 404, "MARKET_NOT_FOUND", "Market not found");
      if (!adapter.capabilities.includes("quote")) {
        return jsonError(c, 400, "CAPABILITY_NOT_SUPPORTED", "quote is not supported for this market");
      }

      const settled = await Promise.allSettled(
        parsed.data.symbols.map(async (symbol) => {
          const normalized = await normalizeSymbol(adapter, symbol);
          return adapter.getQuote(normalized);
        }),
      );
      const quotes: unknown[] = [];
      const errors: Array<{ symbol: string; error: { code: string; message: string } }> = [];

      for (let i = 0; i < settled.length; i += 1) {
        const symbol = parsed.data.symbols[i];
        const result = settled[i];
        if (!symbol || !result) continue;

        if (result.status === "fulfilled") {
          quotes.push(result.value);
          continue;
        }

        errors.push({ symbol, error: toBatchError(result.reason) });
      }

      return c.json({ quotes, errors });
    }),
  );

  router.get(
    "/:market/orderbook",
    withErrorHandling(async (c) => {
      const parsed = parseQuery(c, quoteQuerySchema);
      if (!parsed.success) return parsed.response;

      const adapter = registry.get(c.req.param("market"));
      if (!adapter) return jsonError(c, 404, "MARKET_NOT_FOUND", "Market not found");
      if (!adapter.capabilities.includes("orderbook") || typeof adapter.getOrderbook !== "function") {
        return jsonError(c, 400, "CAPABILITY_NOT_SUPPORTED", "orderbook is not supported for this market");
      }

      const symbol = await normalizeSymbol(adapter, parsed.data.symbol);
      const orderbook = await adapter.getOrderbook(symbol);
      return c.json(orderbook);
    }),
  );

  router.get(
    "/:market/orderbooks",
    withErrorHandling(async (c) => {
      const parsed = parseQuery(c, multiQuoteQuerySchema);
      if (!parsed.success) return parsed.response;

      const adapter = registry.get(c.req.param("market"));
      if (!adapter) return jsonError(c, 404, "MARKET_NOT_FOUND", "Market not found");
      if (!adapter.capabilities.includes("orderbook") || typeof adapter.getOrderbook !== "function") {
        return jsonError(c, 400, "CAPABILITY_NOT_SUPPORTED", "orderbook is not supported for this market");
      }

      const settled = await Promise.allSettled(
        parsed.data.symbols.map(async (symbol) => {
          const normalized = await normalizeSymbol(adapter, symbol);
          return adapter.getOrderbook!(normalized);
        }),
      );
      const orderbooks: unknown[] = [];
      const errors: Array<{ symbol: string; error: { code: string; message: string } }> = [];

      for (let i = 0; i < settled.length; i += 1) {
        const symbol = parsed.data.symbols[i];
        const result = settled[i];
        if (!symbol || !result) continue;

        if (result.status === "fulfilled") {
          orderbooks.push(result.value);
          continue;
        }

        errors.push({ symbol, error: toBatchError(result.reason) });
      }

      return c.json({ orderbooks, errors });
    }),
  );

  router.get(
    "/:market/funding",
    withErrorHandling(async (c) => {
      const parsed = parseQuery(c, quoteQuerySchema);
      if (!parsed.success) return parsed.response;

      const adapter = registry.get(c.req.param("market"));
      if (!adapter) return jsonError(c, 404, "MARKET_NOT_FOUND", "Market not found");
      if (!adapter.capabilities.includes("funding") || typeof adapter.getFundingRate !== "function") {
        return jsonError(c, 400, "CAPABILITY_NOT_SUPPORTED", "funding is not supported for this market");
      }

      const symbol = await normalizeSymbol(adapter, parsed.data.symbol);
      const funding = await adapter.getFundingRate(symbol);
      return c.json(funding);
    }),
  );

  router.get(
    "/:market/fundings",
    withErrorHandling(async (c) => {
      const parsed = parseQuery(c, multiQuoteQuerySchema);
      if (!parsed.success) return parsed.response;

      const adapter = registry.get(c.req.param("market"));
      if (!adapter) return jsonError(c, 404, "MARKET_NOT_FOUND", "Market not found");
      if (!adapter.capabilities.includes("funding") || typeof adapter.getFundingRate !== "function") {
        return jsonError(c, 400, "CAPABILITY_NOT_SUPPORTED", "funding is not supported for this market");
      }

      const settled = await Promise.allSettled(
        parsed.data.symbols.map(async (symbol) => {
          const normalized = await normalizeSymbol(adapter, symbol);
          return adapter.getFundingRate!(normalized);
        }),
      );
      const fundings: unknown[] = [];
      const errors: Array<{ symbol: string; error: { code: string; message: string } }> = [];

      for (let i = 0; i < settled.length; i += 1) {
        const symbol = parsed.data.symbols[i];
        const result = settled[i];
        if (!symbol || !result) continue;

        if (result.status === "fulfilled") {
          fundings.push(result.value);
          continue;
        }

        errors.push({ symbol, error: toBatchError(result.reason) });
      }

      return c.json({ fundings, errors });
    }),
  );

  router.get(
    "/:market/resolve",
    withErrorHandling(async (c) => {
      const parsed = parseQuery(c, quoteQuerySchema);
      if (!parsed.success) return parsed.response;

      const adapter = registry.get(c.req.param("market"));
      if (!adapter) return jsonError(c, 404, "MARKET_NOT_FOUND", "Market not found");
      if (!adapter.capabilities.includes("resolve") || typeof adapter.resolve !== "function") {
        return jsonError(c, 400, "CAPABILITY_NOT_SUPPORTED", "resolve is not supported for this market");
      }

      const symbol = await normalizeSymbol(adapter, parsed.data.symbol);
      const resolution = await adapter.resolve(symbol);
      return c.json(resolution ?? { symbol, resolved: false, outcome: null, settlementPrice: null });
    }),
  );

  return router;
};

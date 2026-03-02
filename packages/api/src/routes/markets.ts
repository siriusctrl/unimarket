import { quoteQuerySchema, searchMarketQuerySchema } from "@unimarket/core";
import type { MarketRegistry } from "@unimarket/markets";
import { Hono } from "hono";

import type { AppVariables } from "../auth.js";
import { jsonError } from "../errors.js";
import { parseQuery, withErrorHandling } from "../helpers.js";

export const createMarketRoutes = (registry: MarketRegistry) => {
  const router = new Hono<{ Variables: AppVariables }>();

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

      const results = await adapter.search(parsed.data.q);
      return c.json({ results });
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

      const quote = await adapter.getQuote(parsed.data.symbol);
      return c.json(quote);
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

      const orderbook = await adapter.getOrderbook(parsed.data.symbol);
      return c.json(orderbook);
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

      const resolution = await adapter.resolve(parsed.data.symbol);
      return c.json(resolution ?? { symbol: parsed.data.symbol, resolved: false, outcome: null, settlementPrice: null });
    }),
  );

  return router;
};

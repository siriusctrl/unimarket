import { describe, expect, it } from "vitest";

import {
  adminAmountSchema,
  createJournalSchema,
  listOrdersQuerySchema,
  listPositionsQuerySchema,
  multiQuoteQuerySchema,
  paginationQuerySchema,
  priceHistoryQuerySchema,
  placeOrderSchema,
  registerSchema,
  reasoningSchema,
  searchMarketQuerySchema,
} from "../src/schemas.js";

describe("schemas", () => {
  it("enforces reasoning to be non-empty after trim", () => {
    expect(reasoningSchema.safeParse("   ").success).toBe(false);
    expect(reasoningSchema.safeParse("because macro regime changed").success).toBe(true);
  });

  it("requires userName for register", () => {
    expect(registerSchema.safeParse({ userName: "agent-alpha" }).success).toBe(true);
    expect(registerSchema.safeParse({ name: "legacy-agent" }).success).toBe(false);
    expect(registerSchema.safeParse({}).success).toBe(false);
  });

  it("requires limitPrice for limit orders", () => {
    const missingLimit = placeOrderSchema.safeParse({
      market: "polymarket",
      reference: "market-ref",
      side: "buy",
      type: "limit",
      quantity: 10,
      reasoning: "Place resting order near support",
    });
    expect(missingLimit.success).toBe(false);

    const validLimit = placeOrderSchema.safeParse({
      market: "polymarket",
      reference: "market-ref",
      side: "buy",
      type: "limit",
      quantity: 10,
      limitPrice: 0.42,
      reasoning: "Place resting order near support",
    });
    expect(validLimit.success).toBe(true);

    const fractionalQuantity = placeOrderSchema.safeParse({
      market: "hyperliquid",
      reference: "BTC",
      side: "buy",
      type: "market",
      quantity: 0.25,
      reasoning: "fractional quantity allowed at schema layer; market rules validate precision",
    });
    expect(fractionalQuantity.success).toBe(true);
  });

  it("accepts optional prediction snapshots on orders", () => {
    const valid = placeOrderSchema.safeParse({
      market: "polymarket",
      reference: "market-ref",
      side: "buy",
      type: "market",
      quantity: 10,
      reasoning: "The market underprices the Yes outcome",
      prediction: {
        outcome: "Yes",
        probability: 0.64,
        conviction: 0.72,
        thesis: "Base rate and recent signal both moved higher",
      },
    });
    expect(valid.success).toBe(true);

    const invalid = placeOrderSchema.safeParse({
      market: "polymarket",
      reference: "market-ref",
      side: "buy",
      type: "market",
      quantity: 10,
      reasoning: "The market underprices the Yes outcome",
      prediction: {
        outcome: "Yes",
        probability: 1.2,
      },
    });
    expect(invalid.success).toBe(false);
  });

  it("coerces and defaults pagination + order list query params", () => {
    const pagination = paginationQuerySchema.parse({});
    expect(pagination).toEqual({ limit: 20, offset: 0 });

    const defaultOrders = listOrdersQuerySchema.parse({});
    expect(defaultOrders).toMatchObject({
      view: "all",
      limit: 20,
      offset: 0,
    });

    const listOrders = listOrdersQuerySchema.parse({
      view: "open",
      status: "pending",
      limit: "10",
      offset: "2",
    });

    expect(listOrders).toMatchObject({
      view: "open",
      status: "pending",
      limit: 10,
      offset: 2,
    });

    expect(listPositionsQuerySchema.parse({})).toEqual({});
    expect(listPositionsQuerySchema.parse({ userId: "usr_1" })).toEqual({ userId: "usr_1" });

    expect(multiQuoteQuerySchema.parse({ references: "abc,def,abc" })).toEqual({ references: ["abc", "def"] });
    expect(multiQuoteQuerySchema.safeParse({ references: "" }).success).toBe(false);
    expect(multiQuoteQuerySchema.safeParse({ references: "x".repeat(1) }).success).toBe(true);
    expect(searchMarketQuerySchema.parse({ q: "nvda" })).toEqual({ q: "nvda", sort: undefined, limit: 20, offset: 0 });
    expect(searchMarketQuerySchema.parse({ q: "nvda", sort: "volume", limit: "5", offset: "1" })).toEqual({
      q: "nvda",
      sort: "volume",
      limit: 5,
      offset: 1,
    });
  });

  it("validates journal and admin amount payloads", () => {
    expect(
      createJournalSchema.safeParse({
        content: "Observed spread compression in correlated contracts",
        tags: ["spread", "observation"],
      }).success,
    ).toBe(true);

    expect(adminAmountSchema.safeParse({ amount: 0 }).success).toBe(false);
    expect(adminAmountSchema.safeParse({ amount: 500 }).success).toBe(true);
  });

  it("validates price history query ranges and lookbacks", () => {
    expect(priceHistoryQuerySchema.parse({ reference: "BTC" })).toEqual({ reference: "BTC" });
    expect(
      priceHistoryQuerySchema.parse({
        reference: "BTC",
        interval: "1h",
        lookback: "7d",
        asOf: "2026-03-08T00:00:00.000Z",
      }),
    ).toMatchObject({
      reference: "BTC",
      interval: "1h",
      lookback: "7d",
      asOf: "2026-03-08T00:00:00.000Z",
    });

    expect(
      priceHistoryQuerySchema.safeParse({
        reference: "BTC",
        startTime: "2026-03-07T00:00:00.000Z",
      }).success,
    ).toBe(false);

    expect(
      priceHistoryQuerySchema.safeParse({
        reference: "BTC",
        lookback: "7d",
        startTime: "2026-03-01T00:00:00.000Z",
        endTime: "2026-03-08T00:00:00.000Z",
      }).success,
    ).toBe(false);

    expect(
      priceHistoryQuerySchema.safeParse({
        reference: "BTC",
        startTime: "invalid",
        endTime: "2026-03-08T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});

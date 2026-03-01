import { describe, expect, it } from "vitest";

import {
  adminAmountSchema,
  createJournalSchema,
  listOrdersQuerySchema,
  listPositionsQuerySchema,
  paginationQuerySchema,
  placeOrderSchema,
  registerSchema,
  reconcileOrdersSchema,
  reasoningSchema,
} from "../src/schemas.js";

describe("schemas", () => {
  it("enforces reasoning to be non-empty after trim", () => {
    expect(reasoningSchema.safeParse("   ").success).toBe(false);
    expect(reasoningSchema.safeParse("because macro regime changed").success).toBe(true);
  });

  it("accepts userName for register while keeping legacy name compatibility", () => {
    expect(registerSchema.safeParse({ userName: "agent-alpha" }).success).toBe(true);
    expect(registerSchema.safeParse({ name: "legacy-agent" }).success).toBe(true);
    expect(registerSchema.safeParse({}).success).toBe(false);
  });

  it("requires limitPrice for limit orders", () => {
    const missingLimit = placeOrderSchema.safeParse({
      market: "polymarket",
      symbol: "0x-abc",
      side: "buy",
      type: "limit",
      quantity: 10,
      reasoning: "Place resting order near support",
    });
    expect(missingLimit.success).toBe(false);

    const validLimit = placeOrderSchema.safeParse({
      market: "polymarket",
      symbol: "0x-abc",
      side: "buy",
      type: "limit",
      quantity: 10,
      limitPrice: 0.42,
      reasoning: "Place resting order near support",
    });
    expect(validLimit.success).toBe(true);
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
  });

  it("validates reconcile, journal, and admin amount payloads", () => {
    expect(
      reconcileOrdersSchema.safeParse({
        reasoning: "Re-evaluate pending orders after quote update",
      }).success,
    ).toBe(true);

    expect(
      createJournalSchema.safeParse({
        content: "Observed spread compression in correlated contracts",
        tags: ["spread", "observation"],
      }).success,
    ).toBe(true);

    expect(adminAmountSchema.safeParse({ amount: 0 }).success).toBe(false);
    expect(adminAmountSchema.safeParse({ amount: 500 }).success).toBe(true);
  });
});

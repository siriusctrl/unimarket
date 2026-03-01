import { describe, expect, it } from "vitest";

import { executeFill, TradingError } from "../src/engine.js";

describe("executeFill", () => {
  it("buys and updates weighted average cost", () => {
    const result = executeFill({
      balance: 100,
      position: { quantity: 10, avgCost: 2 },
      side: "buy",
      quantity: 5,
      price: 4,
    });

    expect(result.nextBalance).toBe(80);
    expect(result.nextPosition).toEqual({ quantity: 15, avgCost: 2.666667 });
  });

  it("throws when balance is not enough", () => {
    expect(() =>
      executeFill({
        balance: 10,
        side: "buy",
        quantity: 100,
        price: 1,
      }),
    ).toThrowError(TradingError);
  });

  it("sells and realizes pnl", () => {
    const result = executeFill({
      balance: 0,
      position: { quantity: 10, avgCost: 0.4 },
      side: "sell",
      quantity: 5,
      price: 0.6,
    });

    expect(result.nextBalance).toBe(3);
    expect(result.nextPosition).toEqual({ quantity: 5, avgCost: 0.4 });
    expect(result.realizedPnl).toBe(1);
  });
});

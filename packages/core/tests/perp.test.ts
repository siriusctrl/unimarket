import { describe, expect, it } from "vitest";

import {
  calculatePerpLiquidationPrice,
  calculatePerpMaintenanceMargin,
  calculatePerpPositionEquity,
  calculatePerpUnrealizedPnl,
  executePerpFill,
} from "../src/perp.js";
import { TradingError } from "../src/engine.js";

describe("perp engine", () => {
  it("opens long with isolated margin", () => {
    const result = executePerpFill({
      balance: 1_000,
      side: "buy",
      quantity: 2,
      price: 100,
      leverage: 10,
      maintenanceMarginRatio: 0.05,
    });

    expect(result.nextBalance).toBeCloseTo(980, 6);
    expect(result.nextPosition).toMatchObject({
      quantity: 2,
      avgCost: 100,
      margin: 20,
      leverage: 10,
      maintenanceMarginRatio: 0.05,
    });
    expect(result.realizedPnl).toBe(0);
  });

  it("opens short with isolated margin", () => {
    const result = executePerpFill({
      balance: 1_000,
      side: "sell",
      quantity: 2,
      price: 100,
      leverage: 5,
      maintenanceMarginRatio: 0.05,
    });

    expect(result.nextBalance).toBeCloseTo(960, 6);
    expect(result.nextPosition?.quantity).toBe(-2);
    expect(result.nextPosition?.margin).toBeCloseTo(40, 6);
  });

  it("partially closes long and realizes pnl while releasing margin", () => {
    const opened = executePerpFill({
      balance: 1_000,
      side: "buy",
      quantity: 10,
      price: 100,
      leverage: 10,
      maintenanceMarginRatio: 0.05,
    });
    const closed = executePerpFill({
      balance: opened.nextBalance,
      position: opened.nextPosition,
      side: "sell",
      quantity: 4,
      price: 110,
      leverage: 10,
      maintenanceMarginRatio: 0.05,
    });

    expect(closed.realizedPnl).toBeCloseTo(40, 6);
    expect(closed.nextBalance).toBeCloseTo(980, 6);
    expect(closed.nextPosition).toMatchObject({
      quantity: 6,
      avgCost: 100,
      margin: 60,
    });
  });

  it("flips long to short", () => {
    const opened = executePerpFill({
      balance: 1_000,
      side: "buy",
      quantity: 5,
      price: 100,
      leverage: 10,
      maintenanceMarginRatio: 0.05,
    });

    const flipped = executePerpFill({
      balance: opened.nextBalance,
      position: opened.nextPosition,
      side: "sell",
      quantity: 8,
      price: 90,
      leverage: 10,
      maintenanceMarginRatio: 0.05,
    });

    expect(flipped.realizedPnl).toBeCloseTo(-50, 6);
    expect(flipped.nextPosition).toMatchObject({
      quantity: -3,
      avgCost: 90,
      margin: 27,
    });
    expect(flipped.nextBalance).toBeCloseTo(923, 6);
  });

  it("enforces reduceOnly semantics", () => {
    expect(() =>
      executePerpFill({
        balance: 100,
        side: "sell",
        quantity: 1,
        price: 100,
        leverage: 5,
        maintenanceMarginRatio: 0.05,
        reduceOnly: true,
      }),
    ).toThrowError(TradingError);
  });

  it("prevents increasing with different leverage", () => {
    const opened = executePerpFill({
      balance: 1_000,
      side: "buy",
      quantity: 2,
      price: 100,
      leverage: 5,
      maintenanceMarginRatio: 0.05,
    });

    expect(() =>
      executePerpFill({
        balance: opened.nextBalance,
        position: opened.nextPosition,
        side: "buy",
        quantity: 1,
        price: 100,
        leverage: 10,
        maintenanceMarginRatio: 0.05,
      }),
    ).toThrowError(TradingError);
  });

  it("applies taker fee on perp fills", () => {
    const opened = executePerpFill({
      balance: 1_000,
      side: "buy",
      quantity: 2,
      price: 100,
      leverage: 10,
      maintenanceMarginRatio: 0.05,
      takerFeeRate: 0.01,
    });
    expect(opened.feePaid).toBe(2);
    expect(opened.nextBalance).toBe(978);

    const closed = executePerpFill({
      balance: opened.nextBalance,
      position: opened.nextPosition,
      side: "sell",
      quantity: 2,
      price: 100,
      leverage: 10,
      maintenanceMarginRatio: 0.05,
      takerFeeRate: 0.01,
    });
    expect(closed.feePaid).toBe(2);
    expect(closed.nextBalance).toBe(996);
  });
});

describe("perp metrics", () => {
  it("computes unrealized pnl, maintenance margin, and position equity", () => {
    const position = {
      quantity: 2,
      avgCost: 100,
      margin: 20,
      leverage: 10,
      maintenanceMarginRatio: 0.05,
    };

    expect(calculatePerpUnrealizedPnl(position, 110)).toBe(20);
    expect(calculatePerpMaintenanceMargin(position, 110)).toBe(11);
    expect(calculatePerpPositionEquity(position, 110)).toBe(40);
  });

  it("computes liquidation price for long and short", () => {
    const longLiq = calculatePerpLiquidationPrice({
      quantity: 2,
      avgCost: 100,
      margin: 20,
      maintenanceMarginRatio: 0.05,
    });
    const shortLiq = calculatePerpLiquidationPrice({
      quantity: -2,
      avgCost: 100,
      margin: 20,
      maintenanceMarginRatio: 0.05,
    });

    expect(longLiq).toBeCloseTo(94.736842, 6);
    expect(shortLiq).toBeCloseTo(104.761905, 6);
  });
});

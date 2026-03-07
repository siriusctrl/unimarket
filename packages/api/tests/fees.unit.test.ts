import { afterEach, describe, expect, it } from "vitest";

import { getTakerFeeRate } from "../src/fees.js";

describe("getTakerFeeRate", () => {
  afterEach(() => {
    delete process.env.DEFAULT_TAKER_FEE_RATE;
    delete process.env.POLYMARKET_TAKER_FEE_RATE;
  });

  it("prefers market-specific fee rates", () => {
    process.env.DEFAULT_TAKER_FEE_RATE = "0.01";
    process.env.POLYMARKET_TAKER_FEE_RATE = "0.02";

    expect(getTakerFeeRate("polymarket")).toBe(0.02);
  });

  it("falls back to the default fee rate and zero", () => {
    process.env.DEFAULT_TAKER_FEE_RATE = "0.015";
    expect(getTakerFeeRate("hyperliquid")).toBe(0.015);

    delete process.env.DEFAULT_TAKER_FEE_RATE;
    expect(getTakerFeeRate("hyperliquid")).toBe(0);
  });

  it("rejects invalid fee configuration", () => {
    process.env.DEFAULT_TAKER_FEE_RATE = "1";
    expect(() => getTakerFeeRate("hyperliquid")).toThrow("DEFAULT_TAKER_FEE_RATE");

    process.env.DEFAULT_TAKER_FEE_RATE = "0.01";
    process.env.POLYMARKET_TAKER_FEE_RATE = "-0.1";
    expect(() => getTakerFeeRate("polymarket")).toThrow("POLYMARKET_TAKER_FEE_RATE");
  });
});

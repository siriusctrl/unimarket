import { describe, expect, it } from "vitest";

import { getExecutionPrice } from "../src/quotes.js";

describe("getExecutionPrice", () => {
  it("uses the executable side and falls back to the reference price", () => {
    expect(getExecutionPrice({ price: 100, bid: 99, ask: 101 }, "buy")).toBe(101);
    expect(getExecutionPrice({ price: 100, bid: 99, ask: 101 }, "sell")).toBe(99);
    expect(getExecutionPrice({ price: 100 }, "buy")).toBe(100);
    expect(getExecutionPrice({ price: 100 }, "sell")).toBe(100);
  });
});

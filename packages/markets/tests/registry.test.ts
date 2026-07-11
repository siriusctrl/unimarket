import { describe, expect, it } from "vitest";

import { MarketRegistry } from "../src/registry.js";
import type { MarketAdapter } from "../src/types.js";

const adapter: MarketAdapter = {
  marketId: "mock",
  displayName: "Mock",
  description: "mock",
  referenceFormat: "id",
  priceRange: null,
  search: async () => [],
  normalizeReference: async (reference) => reference,
  getQuote: async (reference) => ({ reference, price: 1, timestamp: new Date().toISOString() }),
  getTradingConstraints: async () => ({ minQuantity: 1, quantityStep: 1, supportsFractional: false, maxLeverage: null }),
};

describe("MarketRegistry", () => {
  it("registers, gets, and lists markets", () => {
    const registry = new MarketRegistry();
    registry.register(adapter);

    const markets = registry.list();
    expect(markets).toHaveLength(1);
    expect(markets[0]).toMatchObject({ id: "mock", referenceFormat: "id", searchSortOptions: [], priceHistory: null });
    expect(registry.get("mock")).toBe(adapter);
    expect(registry.get("missing")).toBeUndefined();
  });

  it("rejects duplicate adapter registration", () => {
    const registry = new MarketRegistry();
    registry.register(adapter);

    expect(() => registry.register(adapter)).toThrow("Market adapter already registered");
  });
});

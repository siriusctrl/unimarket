import { describe, expect, it } from "vitest";

import { MarketRegistry } from "../src/registry.js";
import type { MarketAdapter } from "../src/types.js";

const adapter: MarketAdapter = {
  marketId: "mock",
  displayName: "Mock",
  description: "mock",
  referenceFormat: "id",
  priceRange: null,
  capabilities: ["search", "quote"],
  search: async () => [],
  getQuote: async (reference) => ({ reference, price: 1, timestamp: new Date().toISOString() }),
};

describe("MarketRegistry", () => {
  it("registers, gets, and lists markets", () => {
    const registry = new MarketRegistry();
    registry.register(adapter);

    const markets = registry.list();
    expect(markets).toHaveLength(1);
    expect(markets[0]).toMatchObject({ id: "mock", referenceFormat: "id" });
    expect(registry.get("mock")).toBe(adapter);
    expect(registry.get("missing")).toBeUndefined();
  });

  it("rejects duplicate adapter registration", () => {
    const registry = new MarketRegistry();
    registry.register(adapter);

    expect(() => registry.register(adapter)).toThrow("Market adapter already registered");
  });
});

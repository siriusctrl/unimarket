import { describe, expect, it } from "vitest";

import { MarketRegistry } from "../src/registry.js";
import type { MarketAdapter } from "../src/types.js";

const adapter: MarketAdapter = {
  marketId: "mock",
  displayName: "Mock",
  description: "mock",
  symbolFormat: "id",
  priceRange: null,
  capabilities: ["search", "quote"],
  search: async () => [],
  getQuote: async (symbol) => ({ symbol, price: 1, timestamp: new Date().toISOString() }),
};

describe("MarketRegistry", () => {
  it("registers and lists markets", () => {
    const registry = new MarketRegistry();
    registry.register(adapter);

    const markets = registry.list();
    expect(markets).toHaveLength(1);
    expect(markets[0]?.id).toBe("mock");
  });
});

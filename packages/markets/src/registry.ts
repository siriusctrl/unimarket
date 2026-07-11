import { getMarketCapabilities, type MarketAdapter, type MarketDescriptor } from "./types.js";

export class MarketRegistry {
  private readonly adapters = new Map<string, MarketAdapter>();

  register(adapter: MarketAdapter): void {
    if (this.adapters.has(adapter.marketId)) {
      throw new Error(`Market adapter already registered: ${adapter.marketId}`);
    }

    this.adapters.set(adapter.marketId, adapter);
  }

  get(marketId: string): MarketAdapter | undefined {
    return this.adapters.get(marketId);
  }

  list(): MarketDescriptor[] {
    return Array.from(this.adapters.values()).map((adapter) => ({
      id: adapter.marketId,
      name: adapter.displayName,
      description: adapter.description,
      referenceFormat: adapter.referenceFormat,
      priceRange: adapter.priceRange,
      capabilities: getMarketCapabilities(adapter),
      browseOptions: adapter.browseOptions ?? [],
      searchSortOptions: adapter.searchSortOptions ?? [],
      priceHistory: adapter.priceHistory ?? null,
    }));
  }
}

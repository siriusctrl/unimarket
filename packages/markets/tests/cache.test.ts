import { describe, expect, it, vi } from "vitest";

import { TtlCache } from "../src/cache.js";

describe("TtlCache", () => {
  it("returns cached values before expiry and clears expired entries", () => {
    vi.useFakeTimers();
    try {
      const cache = new TtlCache();
      cache.set("k", { price: 0.5 }, 1_000);

      expect(cache.get<{ price: number }>("k")).toEqual({ price: 0.5 });

      vi.advanceTimersByTime(1_001);
      expect(cache.get<{ price: number }>("k")).toBeUndefined();
      expect(cache.get<{ price: number }>("k")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns undefined for missing keys", () => {
    const cache = new TtlCache();
    expect(cache.get("missing")).toBeUndefined();
  });

  it("evicts oldest entries when max size is reached", () => {
    const cache = new TtlCache(2);
    cache.set("a", 1, 10_000);
    cache.set("b", 2, 10_000);
    cache.set("c", 3, 10_000);

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });
});

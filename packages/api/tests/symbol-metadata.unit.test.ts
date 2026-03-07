import { afterEach, describe, expect, it, vi } from "vitest";

const emptyResolution = () => ({ names: new Map<string, string>(), outcomes: new Map<string, string>() });

const loadModule = async ({
  cachedRows = [],
  registryGet,
  persistThrows = null as Error | null,
}: {
  cachedRows?: Array<{ symbol: string; symbolName: string | null; outcome: string | null; expiresAt: string }>;
  registryGet?: (marketId: string) => { resolveSymbolNames?: (symbols: Iterable<string>) => Promise<ReturnType<typeof emptyResolution>> } | undefined;
  persistThrows?: Error | null;
} = {}) => {
  vi.resetModules();

  const persistedRows: unknown[] = [];
  const tx = {
    insert: vi.fn(() => ({
      values: (row: unknown) => {
        persistedRows.push(row);
        return {
          onConflictDoUpdate: () => ({
            run: async () => {
              if (persistThrows) throw persistThrows;
            },
          }),
        };
      },
    })),
  };

  vi.doMock("../src/db/client.js", () => ({
    db: {
      select: () => ({ from: () => ({ where: () => ({ all: async () => cachedRows }) }) }),
      transaction: async (callback: (mockTx: typeof tx) => Promise<void>) => callback(tx),
    },
  }));

  vi.doMock("../src/db/schema.js", () => ({
    symbolMetadataCache: {
      market: "market",
      symbol: "symbol",
    },
  }));

  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const mod = await import("../src/symbol-metadata.js");
  const registry = { get: vi.fn(registryGet ?? (() => undefined)) };
  return { ...mod, registry, persistedRows, warn };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveSymbolsWithCache", () => {
  it("returns an empty resolution for blank symbols", async () => {
    const { resolveSymbolsWithCache, registry } = await loadModule();
    const result = await resolveSymbolsWithCache(registry as never, "polymarket", [" ", ""]);

    expect(result.names.size).toBe(0);
    expect(result.outcomes.size).toBe(0);
    expect(registry.get).not.toHaveBeenCalled();
  });

  it("uses fresh cache rows without calling upstream resolvers", async () => {
    const { resolveSymbolsWithCache, registry, persistedRows } = await loadModule({
      cachedRows: [
        {
          symbol: "123",
          symbolName: "Fresh market",
          outcome: "Yes",
          expiresAt: "9999-01-01T00:00:00.000Z",
        },
      ],
    });

    const result = await resolveSymbolsWithCache(registry as never, "polymarket", ["123", "123"]);
    expect(result.names.get("123")).toBe("Fresh market");
    expect(result.outcomes.get("123")).toBe("Yes");
    expect(registry.get).not.toHaveBeenCalled();
    expect(persistedRows).toEqual([]);
  });

  it("falls back to per-symbol resolution after a bulk failure and reuses stale cache rows", async () => {
    const resolveSymbolNames = vi
      .fn<(symbols: Iterable<string>) => Promise<ReturnType<typeof emptyResolution>>>()
      .mockRejectedValueOnce(new Error("bulk down"))
      .mockResolvedValueOnce({ names: new Map([["fresh", "Fresh market"]]), outcomes: new Map([["fresh", "Yes"]]) })
      .mockResolvedValueOnce(emptyResolution());

    const { resolveSymbolsWithCache, registry, persistedRows, warn } = await loadModule({
      cachedRows: [
        {
          symbol: "stale",
          symbolName: "Stale market",
          outcome: "No",
          expiresAt: "2000-01-01T00:00:00.000Z",
        },
      ],
      registryGet: () => ({ resolveSymbolNames }),
    });

    const result = await resolveSymbolsWithCache(registry as never, "polymarket", ["fresh", "stale"]);

    expect(result.names.get("fresh")).toBe("Fresh market");
    expect(result.outcomes.get("fresh")).toBe("Yes");
    expect(result.names.get("stale")).toBe("Stale market");
    expect(result.outcomes.get("stale")).toBe("No");
    expect(resolveSymbolNames).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      "[symbol-metadata] bulk resolution failed for market=polymarket symbols=2: bulk down",
    );
    expect(persistedRows).toHaveLength(2);
  });

  it("records misses when bulk resolution succeeds but some symbols remain unresolved", async () => {
    const resolveSymbolNames = vi.fn().mockResolvedValue({ names: new Map([["found", "Found market"]]), outcomes: new Map() });
    const { resolveSymbolsWithCache, registry, persistedRows } = await loadModule({
      registryGet: () => ({ resolveSymbolNames }),
    });

    const result = await resolveSymbolsWithCache(registry as never, "polymarket", ["found", "missing"]);

    expect(result.names.get("found")).toBe("Found market");
    expect(result.names.has("missing")).toBe(false);
    expect(persistedRows).toHaveLength(2);
    expect(persistedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: "missing", lastError: "symbol metadata unavailable" }),
      ]),
    );
  });

  it("returns stale data and stores adapter-missing errors when the market has no resolver", async () => {
    const { resolveSymbolsWithCache, registry, persistedRows } = await loadModule({
      cachedRows: [
        {
          symbol: "stale",
          symbolName: "Legacy market",
          outcome: null,
          expiresAt: "2000-01-01T00:00:00.000Z",
        },
      ],
      registryGet: () => undefined,
    });

    const result = await resolveSymbolsWithCache(registry as never, "polymarket", ["stale", "missing"]);

    expect(result.names.get("stale")).toBe("Legacy market");
    expect(result.names.has("missing")).toBe(false);
    expect(persistedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: "missing", lastError: "adapter does not support symbol resolution" }),
      ]),
    );
  });

  it("warns but still returns results when cache persistence fails", async () => {
    const resolveSymbolNames = vi.fn().mockResolvedValue({ names: new Map([["found", "Found market"]]), outcomes: new Map() });
    const { resolveSymbolsWithCache, registry, warn } = await loadModule({
      registryGet: () => ({ resolveSymbolNames }),
      persistThrows: new Error("write failed"),
    });

    const result = await resolveSymbolsWithCache(registry as never, "polymarket", ["found"]);
    expect(result.names.get("found")).toBe("Found market");
    expect(warn).toHaveBeenCalledWith("[symbol-metadata] cache write failed for market=polymarket", expect.any(Error));
  });
});

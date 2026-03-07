import { afterEach, describe, expect, it, vi } from "vitest";

const loadModule = async (state: {
  orders: unknown[];
  funding: unknown[];
  liquidations: unknown[];
  journal: unknown[];
  resolution?: { names: Map<string, string>; outcomes: Map<string, string> };
}) => {
  vi.resetModules();
  const tables = {
    orders: { __name: "orders", accountId: "orders.accountId", createdAt: "orders.createdAt", id: "orders.id" },
    fundingPayments: { __name: "fundingPayments", accountId: "funding.accountId", createdAt: "funding.createdAt" },
    liquidations: { __name: "liquidations", accountId: "liquidations.accountId", createdAt: "liquidations.createdAt" },
    journal: { __name: "journal", userId: "journal.userId", createdAt: "journal.createdAt" },
  };
  const all = vi.fn();

  vi.doMock("../src/db/client.js", () => ({
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            orderBy: () => ({
              all: async () => {
                all(table);
                if (table === tables.orders || (typeof table === "object" && table !== null && "__name" in table && table.__name === "orders")) {
                  return state.orders;
                }
                if (
                  table === tables.fundingPayments ||
                  (typeof table === "object" && table !== null && "__name" in table && table.__name === "fundingPayments")
                ) {
                  return state.funding;
                }
                if (
                  table === tables.liquidations ||
                  (typeof table === "object" && table !== null && "__name" in table && table.__name === "liquidations")
                ) {
                  return state.liquidations;
                }
                return state.journal;
              },
            }),
          }),
        }),
      }),
    },
  }));

  vi.doMock("../src/db/schema.js", () => tables);

  vi.doMock("../src/symbol-metadata.js", () => ({
    resolveSymbolsWithCache: vi.fn().mockResolvedValue(
      state.resolution ?? { names: new Map<string, string>(), outcomes: new Map<string, string>() },
    ),
  }));

  const mod = await import("../src/timeline.js");
  return { ...mod, all };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildTimelineEvents", () => {
  it("returns journal-only timelines when no account id is provided", async () => {
    const { buildTimelineEvents } = await loadModule({
      orders: [],
      funding: [],
      liquidations: [],
      journal: [
        {
          id: "jr_1",
          userId: "usr_1",
          content: "noted",
          tags: JSON.stringify(["macro"]),
          createdAt: "2026-03-07T00:00:00.000Z",
        },
      ],
    });

    const events = await buildTimelineEvents({
      registry: {} as never,
      userId: "usr_1",
      accountId: null,
      limit: 20,
      offset: 0,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "journal", data: { tags: ["macro"] } });
  });

  it("filters liquidation fill duplicates and decorates polymarket symbol names", async () => {
    const { buildTimelineEvents } = await loadModule({
      orders: [
        {
          id: "ord_fill",
          status: "filled",
          market: "polymarket",
          symbol: "123",
          side: "buy",
          quantity: 1,
          filledPrice: 0.5,
          filledAt: "2026-03-07T00:02:00.000Z",
          cancelledAt: null,
          cancelReasoning: null,
          reasoning: "filled",
          createdAt: "2026-03-07T00:01:00.000Z",
        },
        {
          id: "ord_cancelled",
          status: "cancelled",
          market: "polymarket",
          symbol: "456",
          side: "sell",
          quantity: 2,
          filledPrice: null,
          filledAt: null,
          cancelledAt: "2026-03-07T00:03:00.000Z",
          cancelReasoning: "user cancelled",
          reasoning: "original",
          createdAt: "2026-03-07T00:01:30.000Z",
        },
      ],
      funding: [
        {
          id: "fnd_1",
          market: "polymarket",
          symbol: "123",
          quantity: 1,
          fundingRate: 0.01,
          payment: -1,
          createdAt: "2026-03-07T00:04:00.000Z",
        },
      ],
      liquidations: [
        {
          id: "liq_1",
          orderId: "ord_fill",
          market: "polymarket",
          symbol: "123",
          side: "sell",
          quantity: 1,
          triggerPrice: 0.4,
          executionPrice: 0.39,
          triggerPositionEquity: 10,
          maintenanceMargin: 5,
          grossPayout: 1,
          feeCharged: 0.1,
          netPayout: 0.9,
          cancelledReduceOnlyOrderIds: "{bad json",
          reasoning: "liq",
          createdAt: "2026-03-07T00:05:00.000Z",
        },
      ],
      journal: [],
      resolution: {
        names: new Map([
          ["123", "Election market"],
          ["456", "Inflation market"],
        ]),
        outcomes: new Map([["123", "Yes"]]),
      },
    });

    const events = await buildTimelineEvents({
      registry: {} as never,
      userId: "usr_1",
      accountId: "acct_1",
      limit: 20,
      offset: 0,
    });

    expect(events.some((event) => event.data.id === "ord_fill")).toBe(false);
    expect(events.find((event) => event.data.id === "ord_cancelled")).toMatchObject({
      type: "order.cancelled",
      reasoning: "user cancelled",
      data: { symbolName: "Inflation market" },
    });
    expect(events.find((event) => event.type === "position.liquidated")).toMatchObject({
      data: {
        symbolName: "Election market — Yes",
        cancelledReduceOnlyOrderIds: [],
      },
    });
  });
});

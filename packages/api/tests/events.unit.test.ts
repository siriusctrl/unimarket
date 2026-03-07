import { afterEach, describe, expect, it, vi } from "vitest";

const loadModule = async () => {
  vi.resetModules();
  return import("../src/platform/events.js");
};

describe("eventBus", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches to user-scoped and all-events subscribers and replays by scope", async () => {
    const { eventBus, ALL_EVENTS_SUBSCRIBER } = await loadModule();
    const userListener = vi.fn();
    const allListener = vi.fn();

    const unsubscribeUser = eventBus.subscribe("user-1", userListener);
    eventBus.subscribe(ALL_EVENTS_SUBSCRIBER, allListener);

    const first = eventBus.emit({
      type: "order.cancelled",
      userId: "user-1",
      accountId: "acct-1",
      orderId: "ord-1",
      data: {
        market: "polymarket",
        symbol: "slug",
        side: "buy",
        quantity: 1,
        reasoning: "test",
        cancelledAt: "2026-03-07T00:00:00.000Z",
      },
    });
    eventBus.emit({
      type: "funding.applied",
      userId: "user-2",
      accountId: "acct-2",
      data: {
        market: "hyperliquid",
        symbol: "BTC",
        quantity: 1,
        fundingRate: 0.001,
        payment: 1,
        appliedAt: "2026-03-07T00:00:00.000Z",
      },
    });

    expect(userListener).toHaveBeenCalledTimes(1);
    expect(allListener).toHaveBeenCalledTimes(2);
    expect(eventBus.replay("user-1", 0).map((event) => event.id)).toEqual([first.id]);
    expect(eventBus.replay(ALL_EVENTS_SUBSCRIBER, Number(first.id)).length).toBe(1);

    unsubscribeUser();
    eventBus.emit({
      type: "order.cancelled",
      userId: "user-1",
      accountId: "acct-1",
      orderId: "ord-2",
      data: {
        market: "polymarket",
        symbol: "slug",
        side: "buy",
        quantity: 1,
        reasoning: "test",
        cancelledAt: "2026-03-07T00:00:00.000Z",
      },
    });
    expect(userListener).toHaveBeenCalledTimes(1);
  });

  it("swallows listener errors during dispatch", async () => {
    const { eventBus } = await loadModule();
    vi.spyOn(console, "error").mockImplementation(() => {});

    eventBus.subscribe("user-1", () => {
      throw new Error("listener failed");
    });

    eventBus.emit({
      type: "position.settled",
      userId: "user-1",
      accountId: "acct-1",
      data: {
        market: "polymarket",
        symbol: "slug",
        quantity: 1,
        settlementPrice: 1,
        proceeds: 1,
        settledAt: "2026-03-07T00:00:00.000Z",
      },
    });

    expect(console.error).toHaveBeenCalled();
  });
});

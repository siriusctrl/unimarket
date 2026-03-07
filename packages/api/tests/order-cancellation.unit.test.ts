import { afterEach, describe, expect, it, vi } from "vitest";

const order = {
  id: "ord_1",
  accountId: "acct_1",
  market: "polymarket",
  symbol: "slug",
  side: "buy",
  quantity: 2,
};

const loadModule = async (rowsAffected: number) => {
  vi.resetModules();
  const emit = vi.fn();
  const run = vi.fn().mockResolvedValue({ rowsAffected });
  const tx = {
    update: () => ({
      set: () => ({
        where: () => ({ run }),
      }),
    }),
  };
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));

  vi.doMock("../src/db/client.js", () => ({ db: { transaction } }));
  vi.doMock("../src/platform/events.js", () => ({ eventBus: { emit } }));
  vi.doMock("../src/utils.js", () => ({ nowIso: () => "2026-03-07T00:00:00.000Z" }));

  const mod = await import("../src/services/order-cancellation.js");
  return { ...mod, emit, run, transaction };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("order cancellation", () => {
  it("returns null from cancelPendingOrderInTx when the row was not updated", async () => {
    const { cancelPendingOrderInTx } = await loadModule(0);
    await expect(
      cancelPendingOrderInTx(
        {
          update: () => ({ set: () => ({ where: () => ({ run: async () => ({ rowsAffected: 0 }) }) }) }),
        } as never,
        { order: order as never, reasoning: "reason", cancelledAt: "2026-03-07T00:00:00.000Z" },
      ),
    ).resolves.toBeNull();
  });

  it("returns skipped results when pending orders are already cancelled", async () => {
    const { cancelPendingOrder, emit } = await loadModule(0);
    const result = await cancelPendingOrder({ order: order as never, reasoning: "reason" });

    expect(result).toEqual({ kind: "skipped", reason: "ORDER_NOT_PENDING" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("emits cancellation events when a user id is provided", async () => {
    const { cancelPendingOrder, emit } = await loadModule(1);
    const result = await cancelPendingOrder({ order: order as never, reasoning: "reason", userId: "usr_1" });

    expect(result.kind).toBe("cancelled");
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

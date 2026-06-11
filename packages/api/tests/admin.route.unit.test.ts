import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

const loadRoutes = async (options?: {
  user?: { id: string; name: string } | null;
  account?: { id: string; userId: string; balance: number } | null;
  snapshots?: Array<{
    userId: string;
    snapshotAt: string;
    equity: number;
    balance: number;
    marketValue: number;
    unrealizedPnl: number;
  }>;
  allUsers?: Array<{ id: string; name: string }>;
  parseJsonResult?: { success: true; data: Record<string, unknown> } | { success: false; response: Response };
}) => {
  vi.resetModules();

  const tables = {
    users: { __name: "users" },
    equitySnapshots: { __name: "equitySnapshots" },
    accounts: { __name: "accounts" },
    journal: { __name: "journal" },
  };

  const getUserAccountScope = vi.fn().mockResolvedValue({ account: options?.account ?? null, mismatch: false });
  const parseJson = vi.fn().mockResolvedValue(
    options?.parseJsonResult ?? {
      success: true,
      data: { amount: 1 },
    },
  );
  const parseQuery = vi.fn(() => ({ success: true, data: { limit: 20, offset: 0 } }));
  const buildEquityHistoryModel = vi.fn().mockResolvedValue({
    range: "bad",
    series: [
      {
        userId: "usr_1",
        userName: "Alice",
        snapshots: [
          {
            snapshotAt: "2026-03-01T00:00:00.000Z",
            equity: 110,
            balance: 100,
            marketValue: 10,
            unrealizedPnl: 5,
          },
        ],
      },
      {
        userId: "usr_2",
        userName: "usr_2",
        snapshots: [
          {
            snapshotAt: "2026-03-02T00:00:00.000Z",
            equity: 90,
            balance: 95,
            marketValue: -5,
            unrealizedPnl: -2,
          },
        ],
      },
    ],
  });

  vi.doMock("../src/db/client.js", () => ({
    db: {
      select: () => ({
        from: (table: { __name: string }) => ({
          where: () => ({
            get: async () => {
              if (table === tables.users) return options?.user ?? null;
              return null;
            },
            orderBy: () => ({ all: async () => (table === tables.equitySnapshots ? (options?.snapshots ?? []) : []) }),
            all: async () => [],
          }),
          all: async () => (table === tables.users ? (options?.allUsers ?? []) : []),
        }),
      }),
      insert: () => ({ values: () => ({ run: async () => ({ rowsAffected: 1 }) }) }),
      update: () => ({ set: () => ({ where: () => ({ run: async () => ({ rowsAffected: 1 }) }) }) }),
    },
  }));
  vi.doMock("../src/db/schema.js", () => tables);
  vi.doMock("../src/platform/helpers.js", () => ({
    getUserAccountScope,
    parseJson,
    parseQuery,
    requireUserRecord: async (_c: unknown, _userId: string) =>
      options?.user
        ? { success: true, user: options.user }
        : {
          success: false,
          response: new Response(JSON.stringify({ error: { code: "USER_NOT_FOUND", message: "User not found" } }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
        },
    withErrorHandling: (fn: (c: unknown) => Promise<Response>) => fn,
  }));
  vi.doMock("../src/platform/errors.js", () => ({
    jsonError: (_c: unknown, status: number, code: string, message: string) =>
      new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "content-type": "application/json" } }),
  }));
  vi.doMock("../src/services/admin-overview.js", () => ({ buildAdminOverviewModel: vi.fn().mockResolvedValue({}) }));
  vi.doMock("../src/services/equity-history.js", () => ({ buildEquityHistoryModel }));
  vi.doMock("../src/services/portfolio-read.js", () => ({
    buildAccountPortfolioModel: vi.fn().mockResolvedValue({}),
    presentAccountPortfolioModel: vi.fn(async ({ portfolio }: { portfolio: Record<string, unknown> }) => portfolio),
  }));
  vi.doMock("../src/timeline.js", () => ({ buildTimelineEvents: vi.fn().mockResolvedValue([]) }));
  vi.doMock("../src/utils.js", () => ({ makeId: (prefix: string) => `${prefix}_1`, nowIso: () => "2026-03-07T00:00:00.000Z" }));

  const { createAdminRoutes } = await import("../src/routes/admin.js");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", "admin_1" as never);
    await next();
  });
  app.route("/admin", createAdminRoutes({} as never));

  return { app, getUserAccountScope, parseJson };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin routes", () => {
  it("groups equity history by user and falls back to user ids for missing names", async () => {
    const routes = await loadRoutes({
      snapshots: [
        {
          userId: "usr_1",
          snapshotAt: "2026-03-01T00:00:00.000Z",
          equity: 110,
          balance: 100,
          marketValue: 10,
          unrealizedPnl: 5,
        },
        {
          userId: "usr_2",
          snapshotAt: "2026-03-02T00:00:00.000Z",
          equity: 90,
          balance: 95,
          marketValue: -5,
          unrealizedPnl: -2,
        },
      ],
      allUsers: [{ id: "usr_1", name: "Alice" }],
    });

    const res = await routes.app.request("/admin/equity-history?range=bad");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      range: "bad",
      series: [
        {
          userId: "usr_1",
          userName: "Alice",
          snapshots: [
            {
              snapshotAt: "2026-03-01T00:00:00.000Z",
              equity: 110,
              balance: 100,
              marketValue: 10,
              unrealizedPnl: 5,
            },
          ],
        },
        {
          userId: "usr_2",
          userName: "usr_2",
          snapshots: [
            {
              snapshotAt: "2026-03-02T00:00:00.000Z",
              equity: 90,
              balance: 95,
              marketValue: -5,
              unrealizedPnl: -2,
            },
          ],
        },
      ],
    });
  });

  it("does not expose admin order placement", async () => {
    const routes = await loadRoutes({
      user: { id: "usr_1", name: "Alice" },
      account: { id: "acct_1", userId: "usr_1", balance: 100 },
    });

    const res = await routes.app.request("/admin/users/usr_1/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ market: "spot", reference: "YES", side: "buy", type: "market", quantity: 1, reasoning: "admin" }),
    });

    expect(res.status).toBe(404);
    expect(routes.parseJson).not.toHaveBeenCalled();
    expect(routes.getUserAccountScope).not.toHaveBeenCalled();
  });
});

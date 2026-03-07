import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

const loadRouter = async (options: {
  userId: string | undefined;
  parsed: { success: true; data: { accountId?: string; userId?: string } } | { success: false; response: Response };
  account: { id: string } | null;
  rowsQueue: unknown[][];
}) => {
  vi.resetModules();
  const getUserAccount = vi.fn().mockResolvedValue(options.account);
  const all = vi.fn(() => Promise.resolve(options.rowsQueue.shift() ?? []));

  vi.doMock("../src/platform/helpers.js", () => ({
    getUserAccount,
    parseQuery: vi.fn(() => options.parsed),
    withErrorHandling: (fn: (c: unknown) => Promise<Response>) => fn,
  }));
  vi.doMock("../src/platform/errors.js", () => ({
    jsonError: (_c: unknown, status: number, code: string, message: string) =>
      new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "content-type": "application/json" } }),
  }));
  vi.doMock("../src/db/client.js", () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ all }),
          }),
          orderBy: () => ({ all }),
        }),
      }),
    },
  }));
  vi.doMock("../src/db/schema.js", () => ({
    positions: { market: "market", symbol: "symbol", accountId: "accountId" },
  }));

  const { positionsRoutes } = await import("../src/routes/positions.js");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", options.userId as never);
    await next();
  });
  app.route("/positions", positionsRoutes);
  return { app, getUserAccount };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("positionsRoutes", () => {
  it("returns validation failures from parseQuery", async () => {
    const { app } = await loadRouter({
      userId: "admin",
      parsed: { success: false, response: new Response(JSON.stringify({ error: true }), { status: 400 }) },
      account: null,
      rowsQueue: [],
    });

    const res = await app.request("/positions");
    expect(res.status).toBe(400);
  });

  it("returns empty results for admin account/user mismatches", async () => {
    const { app, getUserAccount } = await loadRouter({
      userId: "admin",
      parsed: { success: true, data: { accountId: "acct_1", userId: "usr_1" } },
      account: { id: "acct_2" },
      rowsQueue: [],
    });

    const res = await app.request("/positions");
    expect(await res.json()).toEqual({ positions: [] });
    expect(getUserAccount).toHaveBeenCalledWith("usr_1");
  });

  it("returns ordered admin positions when no filter is provided", async () => {
    const rows = [{ id: "pos_1" }];
    const { app } = await loadRouter({
      userId: "admin",
      parsed: { success: true, data: {} },
      account: null,
      rowsQueue: [rows],
    });

    const res = await app.request("/positions");
    expect(await res.json()).toEqual({ positions: rows });
  });

  it("returns 404 when a user account is missing and [] for mismatched account ids", async () => {
    const missingAccount = await loadRouter({
      userId: "usr_1",
      parsed: { success: true, data: {} },
      account: null,
      rowsQueue: [],
    });
    const notFound = await missingAccount.app.request("/positions");
    expect(notFound.status).toBe(404);

    const mismatch = await loadRouter({
      userId: "usr_1",
      parsed: { success: true, data: { accountId: "acct_2" } },
      account: { id: "acct_1" },
      rowsQueue: [],
    });
    const res = await mismatch.app.request("/positions");
    expect(await res.json()).toEqual({ positions: [] });
  });
});

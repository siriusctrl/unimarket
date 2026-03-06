import {
  adminAmountSchema,
  INITIAL_BALANCE,
  paginationQuerySchema,
  placeOrderSchema,
  registerSchema,
} from "@unimarket/core";
import type { MarketRegistry } from "@unimarket/markets";
import { and, eq, gte } from "drizzle-orm";
import { Hono } from "hono";

import type { AppVariables } from "../platform/auth.js";
import { db } from "../db/client.js";
import { accounts, equitySnapshots, journal, users } from "../db/schema.js";
import { jsonError } from "../platform/errors.js";
import { getUserAccount, parseJson, parseQuery, withErrorHandling } from "../platform/helpers.js";
import { checkIdempotency, storeIdempotencyResponse } from "../platform/idempotency.js";
import { buildAdminOverviewModel } from "../services/admin-overview.js";
import { createOrderPlacementService } from "../services/order-placement.js";
import { buildAccountPortfolioModel } from "../services/portfolio-read.js";
import { buildTimelineEvents } from "../timeline.js";
import { makeId, nowIso } from "../utils.js";

export const createAdminRoutes = (registry: MarketRegistry) => {
  const router = new Hono<{ Variables: AppVariables }>();
  const { placeOrderForAccount } = createOrderPlacementService(registry);

  const adjustUserBalance = async (
    userId: string,
    amountDelta: number,
  ): Promise<
    { ok: true; balance: number }
    | { ok: false; code: "ACCOUNT_NOT_FOUND" | "INSUFFICIENT_BALANCE"; message: string; status: 404 | 400 }
  > => {
    const account = await getUserAccount(userId);
    if (!account) {
      return { ok: false, status: 404, code: "ACCOUNT_NOT_FOUND", message: "Account not found" };
    }

    if (amountDelta < 0 && account.balance < Math.abs(amountDelta)) {
      return {
        ok: false,
        status: 400,
        code: "INSUFFICIENT_BALANCE",
        message: "Insufficient balance for withdrawal",
      };
    }

    const nextBalance = Number((account.balance + amountDelta).toFixed(6));
    await db.update(accounts).set({ balance: nextBalance }).where(eq(accounts.id, account.id)).run();
    return { ok: true, balance: nextBalance };
  };

  router.post(
    "/users/:id/deposit",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, adminAmountSchema);
      if (!parsed.success) return parsed.response;

      const userId = c.req.param("id");
      const result = await adjustUserBalance(userId, parsed.data.amount);
      if (!result.ok) return jsonError(c, result.status, result.code, result.message);
      return c.json({ balance: result.balance });
    }),
  );

  router.post(
    "/users/:id/withdraw",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, adminAmountSchema);
      if (!parsed.success) return parsed.response;

      const userId = c.req.param("id");
      const result = await adjustUserBalance(userId, -parsed.data.amount);
      if (!result.ok) return jsonError(c, result.status, result.code, result.message);
      return c.json({ balance: result.balance });
    }),
  );

  router.get(
    "/overview",
    withErrorHandling(async (c) => {
      return c.json(await buildAdminOverviewModel({ registry }));
    }),
  );

  router.get(
    "/users/:id/timeline",
    withErrorHandling(async (c) => {
      const userId = c.req.param("id");
      const user = await db.select().from(users).where(eq(users.id, userId)).get();
      if (!user) return jsonError(c, 404, "USER_NOT_FOUND", "User not found");

      const parsedQuery = parseQuery(c, paginationQuerySchema);
      if (!parsedQuery.success) return parsedQuery.response;

      const acc = await getUserAccount(userId);
      const events = await buildTimelineEvents({
        registry,
        userId,
        accountId: acc?.id ?? null,
        limit: parsedQuery.data.limit,
        offset: parsedQuery.data.offset,
      });

      return c.json({ events });
    }),
  );

  const RANGE_MS: Record<string, number> = {
    "1w": 7 * 86_400_000,
    "1m": 30 * 86_400_000,
    "3m": 90 * 86_400_000,
    "6m": 180 * 86_400_000,
    "1y": 365 * 86_400_000,
  };

  router.get(
    "/equity-history",
    withErrorHandling(async (c) => {
      const range = (c.req.query("range") ?? "1m").toLowerCase();
      const ms = RANGE_MS[range] ?? RANGE_MS["1m"];
      const since = new Date(Date.now() - ms).toISOString();

      const rows = await db.select()
        .from(equitySnapshots)
        .where(gte(equitySnapshots.snapshotAt, since))
        .orderBy(equitySnapshots.snapshotAt)
        .all();

      // Group by userId
      const byUser = new Map<string, Array<{
        snapshotAt: string;
        equity: number;
        balance: number;
        marketValue: number;
        unrealizedPnl: number;
      }>>();

      for (const row of rows) {
        if (!byUser.has(row.userId)) byUser.set(row.userId, []);
        byUser.get(row.userId)!.push({
          snapshotAt: row.snapshotAt,
          equity: row.equity,
          balance: row.balance,
          marketValue: row.marketValue,
          unrealizedPnl: row.unrealizedPnl,
        });
      }

      // Get user names
      const userRows = await db.select().from(users).all();
      const nameById = new Map(userRows.map((u) => [u.id, u.name]));

      const series = Array.from(byUser.entries()).map(([userId, snapshots]) => ({
        userId,
        userName: nameById.get(userId) ?? userId,
        snapshots,
      }));

      return c.json({ range, series });
    }),
  );

  // ─── POST /traders — Create a dedicated trader account ─────────────────────

  router.post(
    "/traders",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, registerSchema);
      if (!parsed.success) return parsed.response;

      const createdAt = nowIso();
      const userId = makeId("usr");
      const accountId = makeId("acc");
      const userName = parsed.data.userName;

      await db.insert(users).values({ id: userId, name: userName, createdAt }).run();
      await db
        .insert(accounts)
        .values({
          id: accountId,
          userId,
          balance: INITIAL_BALANCE,
          name: `${userName}-main`,
          reasoning: "Trader account created by admin",
          createdAt,
        })
        .run();

      return c.json({ userId, userName, accountId, balance: INITIAL_BALANCE }, 201);
    }),
  );

  // ─── GET /users/:id/portfolio — Single-user portfolio view ─────────────────

  router.get(
    "/users/:id/portfolio",
    withErrorHandling(async (c) => {
      const userId = c.req.param("id");
      const user = await db.select().from(users).where(eq(users.id, userId)).get();
      if (!user) return jsonError(c, 404, "USER_NOT_FOUND", "User not found");

      const account = await getUserAccount(userId);
      if (!account) return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");

      const portfolio = await buildAccountPortfolioModel({
        account,
        registry,
        includeRecentOrders: true,
        tolerateQuoteFailures: true,
        includeMissingAdapterAsUnpriced: true,
      });

      return c.json({
        userId: user.id,
        userName: user.name,
        accountId: portfolio.accountId,
        balance: portfolio.balance,
        positions: portfolio.positions,
        openOrders: portfolio.openOrders,
        recentOrders: portfolio.recentOrders,
        totalValue: portfolio.totalValue,
        totalPnl: portfolio.totalPnl,
        totalFunding: portfolio.totalFunding,
      });
    }),
  );

  // ─── POST /users/:id/orders — Admin places order on behalf of a user ───────

  router.post(
    "/users/:id/orders",
    withErrorHandling(async (c) => {
      const userId = c.req.param("id");
      const user = await db.select().from(users).where(eq(users.id, userId)).get();
      if (!user) return jsonError(c, 404, "USER_NOT_FOUND", "User not found");

      const parsed = await parseJson(c, placeOrderSchema);
      if (!parsed.success) return parsed.response;

      const account = await getUserAccount(userId);
      if (!account) return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");
      if (parsed.data.accountId && parsed.data.accountId !== account.id) {
        return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");
      }

      const adminUserId = c.get("userId");
      const idempotencyResult = await checkIdempotency(c, adminUserId, { targetUserId: userId, ...parsed.data });
      if (idempotencyResult.kind === "invalid" || idempotencyResult.kind === "replay") {
        return idempotencyResult.response;
      }
      const idempotencyCandidate = idempotencyResult.kind === "store" ? idempotencyResult.candidate : null;
      const maybeStoreResponse = async (response: Response): Promise<void> => {
        if (!idempotencyCandidate) return;
        const clone = response.clone();
        const body = await clone.json();
        await storeIdempotencyResponse(idempotencyCandidate, clone.status, body);
      };
      const placement = await placeOrderForAccount({ account, order: parsed.data });
      if (placement.kind === "error") {
        return jsonError(c, placement.status, placement.code, placement.message);
      }

      const response = c.json(placement.order, 201);
      await maybeStoreResponse(response);
      return response;
    }),
  );

  return router;
};

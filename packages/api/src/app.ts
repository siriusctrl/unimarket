import {
  INITIAL_BALANCE,
  TradingError,
  adminAmountSchema,
  calculateMarketValue,
  calculateUnrealizedPnl,
  cancelOrderSchema,
  createJournalSchema,
  executeFill,
  listOrdersQuerySchema,
  listPositionsQuerySchema,
  paginationQuerySchema,
  placeOrderSchema,
  quoteQuerySchema,
  reconcileOrdersSchema,
  registerSchema,
  searchMarketQuerySchema,
} from "@paper-trade/core";
import { MarketAdapterError, MarketRegistry, PolymarketAdapter } from "@paper-trade/markets";
import { and, asc, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { z } from "zod";

import { adminOnlyMiddleware, authMiddleware, type AppVariables } from "./auth.js";
import { db } from "./db/client.js";
import { accounts, apiKeys, journal, orders, positions, trades, users } from "./db/schema.js";
import { jsonError } from "./errors.js";
import { createApiKey, hashApiKey, keyPrefix, makeId, nowIso } from "./utils.js";

type App = Hono<{ Variables: AppVariables }>;
type AppContext = Context<{ Variables: AppVariables }>;
export type CreateAppOptions = {
  registry?: MarketRegistry;
};

const getValidationErrorPayload = (
  error: z.ZodError,
): {
  code: "INVALID_INPUT" | "REASONING_REQUIRED";
  message: string;
} => {
  const reasoningIssue = error.issues.find((issue) => issue.path[0] === "reasoning");
  if (reasoningIssue) {
    return {
      code: "REASONING_REQUIRED",
      message: "reasoning is required",
    };
  }

  return {
    code: "INVALID_INPUT",
    message: error.issues[0]?.message ?? "Invalid input",
  };
};

const parseJson = async <TSchema extends z.ZodTypeAny>(
  c: AppContext,
  schema: TSchema,
): Promise<{ success: true; data: z.infer<TSchema> } | { success: false; response: Response }> => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { success: false, response: jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON") };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = getValidationErrorPayload(parsed.error);
    return {
      success: false,
      response: jsonError(c, 400, issue.code, issue.message),
    };
  }

  return { success: true, data: parsed.data };
};

const parseQuery = <TSchema extends z.ZodTypeAny>(
  c: AppContext,
  schema: TSchema,
): { success: true; data: z.infer<TSchema> } | { success: false; response: Response } => {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    return {
      success: false,
      response: jsonError(c, 400, "INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid query"),
    };
  }

  return { success: true, data: parsed.data };
};

const withErrorHandling = (fn: (c: AppContext) => Promise<Response>) => {
  return async (c: AppContext): Promise<Response> => {
    try {
      return await fn(c);
    } catch (error) {
      if (error instanceof TradingError) {
        return jsonError(c, 400, error.code, error.message);
      }

      if (error instanceof MarketAdapterError) {
        return jsonError(c, 502, error.code, error.message);
      }

      if (error instanceof Error) {
        return jsonError(c, 500, "INTERNAL_ERROR", error.message);
      }

      return jsonError(c, 500, "INTERNAL_ERROR", "Unknown server error");
    }
  };
};

const serializeTags = (tags: string[] | undefined): string => JSON.stringify(tags ?? []);

const deserializeTags = (raw: string): string[] => {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
};

const getFirst = async <T>(query: Promise<T[]>): Promise<T | undefined> => {
  const rows = await query;
  return rows[0];
};

const getUserAccount = async (userId: string) => {
  return getFirst(
    db
      .select()
      .from(accounts)
      .where(eq(accounts.userId, userId))
      .orderBy(asc(accounts.createdAt))
      .limit(1)
      .all(),
  );
};

const createDefaultRegistry = (): MarketRegistry => {
  const registry = new MarketRegistry();
  registry.register(new PolymarketAdapter());
  return registry;
};

const createOpenApiDocument = (registry: MarketRegistry) => {
  const marketIds = registry.list().map((market) => market.id);

  return {
    openapi: "3.1.0",
    info: {
      title: "paper-trade API",
      version: "0.1.0",
      description: "Polymarket-first, market-agnostic paper trading API",
    },
    servers: [
      {
        url: "http://localhost:3100",
      },
    ],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
        },
      },
    },
    paths: {
      "/health": {
        get: {
          summary: "Health check",
          security: [],
        },
      },
      "/openapi.json": {
        get: {
          summary: "OpenAPI document",
          security: [],
        },
      },
      "/api/auth/register": {
        post: {
          summary: "Register user (userName) and issue first API key + default account",
          security: [],
        },
      },
      "/api/auth/keys": {
        post: {
          summary: "Create additional API key",
        },
      },
      "/api/auth/keys/{id}": {
        delete: {
          summary: "Revoke API key",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        },
      },
      "/api/account": {
        get: {
          summary: "Get current user's default account details",
        },
      },
      "/api/account/portfolio": {
        get: {
          summary: "Get current user's portfolio",
        },
      },
      "/api/account/timeline": {
        get: {
          summary: "Get current user's timeline (orders + journal)",
        },
      },
      "/api/orders": {
        post: {
          summary: "Place order (reasoning required)",
        },
        get: {
          summary: "List orders (view=open|history|all)",
          parameters: [
            { name: "view", in: "query", required: false, schema: { type: "string", enum: ["all", "open", "history"] } },
            { name: "status", in: "query", required: false, schema: { type: "string" } },
            { name: "market", in: "query", required: false, schema: { type: "string", enum: marketIds } },
            { name: "symbol", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer" } },
            { name: "offset", in: "query", required: false, schema: { type: "integer" } },
          ],
        },
      },
      "/api/orders/reconcile": {
        post: {
          summary: "Reconcile and fill marketable pending limit orders (reasoning required)",
        },
      },
      "/api/orders/{id}": {
        get: {
          summary: "Get order by id",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        },
        delete: {
          summary: "Cancel pending order (reasoning required)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        },
      },
      "/api/positions": {
        get: {
          summary: "List positions for current user",
        },
      },
      "/api/journal": {
        post: {
          summary: "Create journal entry",
        },
        get: {
          summary: "List journal entries",
        },
      },
      "/api/markets": {
        get: {
          summary: "List available markets and capabilities",
        },
      },
      "/api/markets/{market}/search": {
        get: {
          summary: "Search symbols/assets in a market",
          parameters: [
            { name: "market", in: "path", required: true, schema: { type: "string", enum: marketIds } },
            { name: "q", in: "query", required: true, schema: { type: "string" } },
          ],
        },
      },
      "/api/markets/{market}/quote": {
        get: {
          summary: "Get market quote",
          parameters: [
            { name: "market", in: "path", required: true, schema: { type: "string", enum: marketIds } },
            { name: "symbol", in: "query", required: true, schema: { type: "string" } },
          ],
        },
      },
      "/api/markets/{market}/orderbook": {
        get: {
          summary: "Get market orderbook",
          parameters: [
            { name: "market", in: "path", required: true, schema: { type: "string", enum: marketIds } },
            { name: "symbol", in: "query", required: true, schema: { type: "string" } },
          ],
        },
      },
      "/api/markets/{market}/resolve": {
        get: {
          summary: "Get settlement status",
          parameters: [
            { name: "market", in: "path", required: true, schema: { type: "string", enum: marketIds } },
            { name: "symbol", in: "query", required: true, schema: { type: "string" } },
          ],
        },
      },
      "/api/admin/users/{id}/deposit": {
        post: {
          summary: "Admin deposit to user's default account",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        },
      },
      "/api/admin/users/{id}/withdraw": {
        post: {
          summary: "Admin withdraw from user's default account",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        },
      },
      "/api/admin/overview": {
        get: {
          summary: "Admin portfolio overview across markets and users",
        },
      },
    },
  };
};

export const createApp = (options: CreateAppOptions = {}): App => {
  const app = new Hono<{ Variables: AppVariables }>();
  const registry = options.registry ?? createDefaultRegistry();

  app.get("/health", (c) => {
    const descriptors = registry.list();
    const marketStatuses = Object.fromEntries(descriptors.map((item) => [item.id, "available"]));
    return c.json({ status: "ok", markets: marketStatuses });
  });

  app.get("/openapi.json", (c) => {
    return c.json(createOpenApiDocument(registry));
  });

  app.post(
    "/api/auth/register",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, registerSchema);
      if (!parsed.success) {
        return parsed.response;
      }

      const createdAt = nowIso();
      const userId = makeId("usr");
      const accountId = makeId("acc");
      const keyId = makeId("key");
      const apiKey = createApiKey();
      const userName = parsed.data.userName ?? parsed.data.name;
      if (!userName) {
        return jsonError(c, 400, "INVALID_INPUT", "userName is required");
      }

      await db.insert(users).values({ id: userId, name: userName, createdAt }).run();

      await db
        .insert(apiKeys)
        .values({
          id: keyId,
          userId,
          keyHash: hashApiKey(apiKey),
          prefix: keyPrefix(apiKey),
          createdAt,
          revokedAt: null,
        })
        .run();

      await db
        .insert(accounts)
        .values({
          id: accountId,
          userId,
          balance: INITIAL_BALANCE,
          name: `${userName}-main`,
          reasoning: "Initial account created at registration",
          createdAt,
        })
        .run();

      return c.json(
        {
          userId,
          apiKey,
          account: {
            id: accountId,
            balance: INITIAL_BALANCE,
            createdAt,
          },
        },
        201,
      );
    }),
  );

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/auth/register") {
      return next();
    }

    return authMiddleware(c, next);
  });

  app.post(
    "/api/auth/keys",
    withErrorHandling(async (c) => {
      const userId = c.get("userId");
      if (!userId || userId === "admin") {
        return jsonError(c, 400, "INVALID_USER", "Admin user cannot create API keys in this endpoint");
      }

      const apiKey = createApiKey();
      const createdAt = nowIso();
      const keyId = makeId("key");

      await db
        .insert(apiKeys)
        .values({
          id: keyId,
          userId,
          keyHash: hashApiKey(apiKey),
          prefix: keyPrefix(apiKey),
          createdAt,
          revokedAt: null,
        })
        .run();

      return c.json({ id: keyId, apiKey, prefix: keyPrefix(apiKey) }, 201);
    }),
  );

  app.delete(
    "/api/auth/keys/:id",
    withErrorHandling(async (c) => {
      const userId = c.get("userId");
      if (!userId || userId === "admin") {
        return jsonError(c, 400, "INVALID_USER", "Admin user cannot revoke via this endpoint");
      }

      const keyId = c.req.param("id");
      const updated = await db
        .update(apiKeys)
        .set({ revokedAt: nowIso() })
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
        .run();

      if (updated.rowsAffected === 0) {
        return jsonError(c, 404, "KEY_NOT_FOUND", "API key not found");
      }

      return c.json({ revoked: true });
    }),
  );

  app.get(
    "/api/account",
    withErrorHandling(async (c) => {
      const userId = c.get("userId");
      if (!userId || userId === "admin") {
        return jsonError(c, 400, "INVALID_USER", "Invalid user for account retrieval");
      }

      const account = await getUserAccount(userId);
      if (!account) {
        return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");
      }

      return c.json({ id: account.id, name: account.name, balance: account.balance, createdAt: account.createdAt });
    }),
  );

  app.get(
    "/api/account/portfolio",
    withErrorHandling(async (c) => {
      const userId = c.get("userId");
      if (!userId || userId === "admin") {
        return jsonError(c, 400, "INVALID_USER", "Invalid user for portfolio");
      }

      const account = await getUserAccount(userId);
      if (!account) {
        return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");
      }

      const rows = await db.select().from(positions).where(eq(positions.accountId, account.id)).all();

      const resultPositions = [] as Array<{
        market: string;
        symbol: string;
        quantity: number;
        avgCost: number;
        currentPrice: number;
        unrealizedPnl: number;
        marketValue: number;
      }>;

      let totalMarketValue = 0;
      for (const row of rows) {
        const adapter = registry.get(row.market);
        if (!adapter) {
          continue;
        }

        const quote = await adapter.getQuote(row.symbol);
        const marketValue = calculateMarketValue({ quantity: row.quantity, avgCost: row.avgCost }, quote.price);
        const unrealizedPnl = calculateUnrealizedPnl({ quantity: row.quantity, avgCost: row.avgCost }, quote.price);

        totalMarketValue += marketValue;

        resultPositions.push({
          market: row.market,
          symbol: row.symbol,
          quantity: row.quantity,
          avgCost: row.avgCost,
          currentPrice: quote.price,
          unrealizedPnl,
          marketValue,
        });
      }

      const totalValue = Number((account.balance + totalMarketValue).toFixed(6));
      const totalPnl = Number(resultPositions.reduce((acc, item) => acc + item.unrealizedPnl, 0).toFixed(6));

      return c.json({
        accountId: account.id,
        balance: account.balance,
        positions: resultPositions,
        totalValue,
        totalPnl,
      });
    }),
  );

  app.get(
    "/api/account/timeline",
    withErrorHandling(async (c) => {
      const userId = c.get("userId");
      if (!userId || userId === "admin") {
        return jsonError(c, 400, "INVALID_USER", "Invalid user for timeline");
      }

      const account = await getUserAccount(userId);
      if (!account) {
        return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");
      }

      const parsedQuery = parseQuery(c, paginationQuerySchema);
      if (!parsedQuery.success) {
        return parsedQuery.response;
      }

      const orderRows = await db.select().from(orders).where(eq(orders.accountId, account.id)).orderBy(desc(orders.createdAt)).all();

      const journalRows = await db.select().from(journal).where(eq(journal.userId, account.userId)).orderBy(desc(journal.createdAt)).all();

      const events = [
        ...orderRows.map((row) => ({
          type: row.status === "cancelled" ? "order_cancelled" : "order",
          data: {
            id: row.id,
            symbol: row.symbol,
            market: row.market,
            side: row.side,
            quantity: row.quantity,
            status: row.status,
            filledPrice: row.filledPrice,
          },
          reasoning: row.status === "cancelled" ? row.cancelReasoning : row.reasoning,
          createdAt: row.createdAt,
        })),
        ...journalRows.map((row) => ({
          type: "journal",
          data: {
            id: row.id,
            content: row.content,
            tags: deserializeTags(row.tags),
          },
          reasoning: null,
          createdAt: row.createdAt,
        })),
      ]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(parsedQuery.data.offset, parsedQuery.data.offset + parsedQuery.data.limit);

      return c.json({ events });
    }),
  );

  app.post(
    "/api/orders",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, placeOrderSchema);
      if (!parsed.success) {
        return parsed.response;
      }

      const userId = c.get("userId");
      if (!userId || userId === "admin") {
        return jsonError(c, 400, "INVALID_USER", "Invalid user for order placement");
      }

      const account = await getUserAccount(userId);
      if (!account) {
        return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");
      }

      const adapter = registry.get(parsed.data.market);
      if (!adapter) {
        return jsonError(c, 404, "MARKET_NOT_FOUND", `Market not found: ${parsed.data.market}`);
      }

      const createdAt = nowIso();
      const orderId = makeId("ord");
      const baseOrder = {
        id: orderId,
        accountId: account.id,
        market: parsed.data.market,
        symbol: parsed.data.symbol,
        side: parsed.data.side,
        type: parsed.data.type,
        quantity: parsed.data.quantity,
        limitPrice: parsed.data.limitPrice ?? null,
        status: parsed.data.type === "market" ? "filled" : "pending",
        filledPrice: null as number | null,
        reasoning: parsed.data.reasoning,
        cancelReasoning: null as string | null,
        filledAt: null as string | null,
        createdAt,
      };

      const persistFilledOrder = async (executionPrice: number): Promise<Response> => {
        const existingPosition = await getFirst(
          db
            .select()
            .from(positions)
            .where(
              and(
                eq(positions.accountId, account.id),
                eq(positions.market, parsed.data.market),
                eq(positions.symbol, parsed.data.symbol),
              ),
            )
            .limit(1)
            .all(),
        );

        const fillResult = executeFill({
          balance: account.balance,
          position: existingPosition ? { quantity: existingPosition.quantity, avgCost: existingPosition.avgCost } : null,
          side: parsed.data.side,
          quantity: parsed.data.quantity,
          price: executionPrice,
          allowShort: false,
        });

        await db
          .update(accounts)
          .set({ balance: fillResult.nextBalance })
          .where(eq(accounts.id, account.id))
          .run();

        if (!fillResult.nextPosition) {
          if (existingPosition) {
            await db.delete(positions).where(eq(positions.id, existingPosition.id)).run();
          }
        } else if (existingPosition) {
          await db
            .update(positions)
            .set({ quantity: fillResult.nextPosition.quantity, avgCost: fillResult.nextPosition.avgCost })
            .where(eq(positions.id, existingPosition.id))
            .run();
        } else {
          await db
            .insert(positions)
            .values({
              id: makeId("pos"),
              accountId: account.id,
              market: parsed.data.market,
              symbol: parsed.data.symbol,
              quantity: fillResult.nextPosition.quantity,
              avgCost: fillResult.nextPosition.avgCost,
            })
            .run();
        }

        await db
          .insert(trades)
          .values({
            id: makeId("trd"),
            orderId,
            accountId: account.id,
            market: parsed.data.market,
            symbol: parsed.data.symbol,
            side: parsed.data.side,
            quantity: parsed.data.quantity,
            price: executionPrice,
            createdAt,
          })
          .run();

        await db
          .insert(orders)
          .values({
            ...baseOrder,
            status: "filled",
            filledPrice: executionPrice,
            filledAt: createdAt,
          })
          .run();

        const filled = await getFirst(db.select().from(orders).where(eq(orders.id, orderId)).limit(1).all());
        return c.json(filled, 201);
      };

      const quoteSidePrice = (price: { price: number; bid?: number; ask?: number }): number => {
        return parsed.data.side === "buy" ? (price.ask ?? price.price) : (price.bid ?? price.price);
      };

      if (parsed.data.type === "limit") {
        let executionPrice: number | null = null;

        try {
          const quote = await adapter.getQuote(parsed.data.symbol);
          const candidatePrice = quoteSidePrice(quote);
          const limitPrice = parsed.data.limitPrice as number;
          const shouldFillNow =
            parsed.data.side === "buy" ? candidatePrice <= limitPrice : candidatePrice >= limitPrice;

          if (shouldFillNow) {
            executionPrice = candidatePrice;
          }
        } catch {
          executionPrice = null;
        }

        if (executionPrice === null) {
          await db.insert(orders).values(baseOrder).run();
          return c.json(baseOrder, 201);
        }

        return persistFilledOrder(executionPrice);
      }

      const quote = await adapter.getQuote(parsed.data.symbol);
      const executionPrice = quoteSidePrice(quote);
      return persistFilledOrder(executionPrice);
    }),
  );

  app.get(
    "/api/orders",
    withErrorHandling(async (c) => {
      const parsed = parseQuery(c, listOrdersQuerySchema);
      if (!parsed.success) {
        return parsed.response;
      }

      const userId = c.get("userId");

      const predicates: SQL[] = [];
      if (userId !== "admin") {
        const account = await getUserAccount(userId);
        if (!account) {
          return c.json({ orders: [] });
        }
        predicates.push(eq(orders.accountId, account.id));
      }

      if (parsed.data.view === "open") {
        predicates.push(eq(orders.status, "pending"));
      } else if (parsed.data.view === "history") {
        predicates.push(inArray(orders.status, ["filled", "cancelled", "rejected"]));
      }

      if (parsed.data.status) {
        predicates.push(eq(orders.status, parsed.data.status));
      }
      if (parsed.data.market) {
        predicates.push(eq(orders.market, parsed.data.market));
      }
      if (parsed.data.symbol) {
        predicates.push(eq(orders.symbol, parsed.data.symbol));
      }

      const whereClause = predicates.length > 0 ? and(...predicates) : undefined;

      const rows = await db
        .select()
        .from(orders)
        .where(whereClause)
        .orderBy(desc(orders.createdAt))
        .limit(parsed.data.limit)
        .offset(parsed.data.offset)
        .all();

      return c.json({ orders: rows });
    }),
  );

  app.get(
    "/api/orders/:id",
    withErrorHandling(async (c) => {
      const orderId = c.req.param("id");
      const userId = c.get("userId");

      const order = await getFirst(db.select().from(orders).where(eq(orders.id, orderId)).limit(1).all());
      if (!order) {
        return jsonError(c, 404, "ORDER_NOT_FOUND", "Order not found");
      }

      if (userId !== "admin") {
        const account = await getUserAccount(userId);
        if (!account || account.id !== order.accountId) {
          return jsonError(c, 404, "ORDER_NOT_FOUND", "Order not found");
        }
      }

      return c.json(order);
    }),
  );

  app.post(
    "/api/orders/reconcile",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, reconcileOrdersSchema);
      if (!parsed.success) {
        return parsed.response;
      }

      const userId = c.get("userId");

      const targetAccountIds: string[] = [];
      if (userId === "admin") {
        const allAccounts = await db.select({ id: accounts.id }).from(accounts).all();
        targetAccountIds.push(...allAccounts.map((item) => item.id));
      } else {
        const account = await getUserAccount(userId);
        if (!account) {
          return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");
        }
        targetAccountIds.push(account.id);
      }

      if (targetAccountIds.length === 0) {
        return c.json({ processed: 0, filled: 0, skipped: 0, filledOrderIds: [] });
      }

      const pendingOrders = await db
        .select()
        .from(orders)
        .where(and(inArray(orders.accountId, targetAccountIds), eq(orders.status, "pending")))
        .orderBy(asc(orders.createdAt))
        .all();

      let filled = 0;
      let skipped = 0;
      const filledOrderIds: string[] = [];

      for (const pendingOrder of pendingOrders) {
        if (pendingOrder.type !== "limit" || pendingOrder.limitPrice === null) {
          skipped += 1;
          continue;
        }

        const adapter = registry.get(pendingOrder.market);
        if (!adapter) {
          skipped += 1;
          continue;
        }

        let quotePrice: number;
        try {
          const quote = await adapter.getQuote(pendingOrder.symbol);
          quotePrice = pendingOrder.side === "buy" ? (quote.ask ?? quote.price) : (quote.bid ?? quote.price);
        } catch {
          skipped += 1;
          continue;
        }

        const shouldFill =
          pendingOrder.side === "buy" ? quotePrice <= pendingOrder.limitPrice : quotePrice >= pendingOrder.limitPrice;

        if (!shouldFill) {
          skipped += 1;
          continue;
        }

        const account = await getFirst(db.select().from(accounts).where(eq(accounts.id, pendingOrder.accountId)).limit(1).all());
        if (!account) {
          skipped += 1;
          continue;
        }

        const existingPosition = await getFirst(
          db
            .select()
            .from(positions)
            .where(
              and(
                eq(positions.accountId, account.id),
                eq(positions.market, pendingOrder.market),
                eq(positions.symbol, pendingOrder.symbol),
              ),
            )
            .limit(1)
            .all(),
        );

        try {
          const fillResult = executeFill({
            balance: account.balance,
            position: existingPosition ? { quantity: existingPosition.quantity, avgCost: existingPosition.avgCost } : null,
            side: pendingOrder.side as "buy" | "sell",
            quantity: pendingOrder.quantity,
            price: quotePrice,
            allowShort: false,
          });

          await db
            .update(accounts)
            .set({ balance: fillResult.nextBalance })
            .where(eq(accounts.id, account.id))
            .run();

          if (!fillResult.nextPosition) {
            if (existingPosition) {
              await db.delete(positions).where(eq(positions.id, existingPosition.id)).run();
            }
          } else if (existingPosition) {
            await db
              .update(positions)
              .set({ quantity: fillResult.nextPosition.quantity, avgCost: fillResult.nextPosition.avgCost })
              .where(eq(positions.id, existingPosition.id))
              .run();
          } else {
            await db
              .insert(positions)
              .values({
                id: makeId("pos"),
                accountId: account.id,
                market: pendingOrder.market,
                symbol: pendingOrder.symbol,
                quantity: fillResult.nextPosition.quantity,
                avgCost: fillResult.nextPosition.avgCost,
              })
              .run();
          }

          const filledAt = nowIso();
          await db
            .insert(trades)
            .values({
              id: makeId("trd"),
              orderId: pendingOrder.id,
              accountId: account.id,
              market: pendingOrder.market,
              symbol: pendingOrder.symbol,
              side: pendingOrder.side,
              quantity: pendingOrder.quantity,
              price: quotePrice,
              createdAt: filledAt,
            })
            .run();

          await db
            .update(orders)
            .set({
              status: "filled",
              filledPrice: quotePrice,
              filledAt,
            })
            .where(eq(orders.id, pendingOrder.id))
            .run();

          filled += 1;
          filledOrderIds.push(pendingOrder.id);
        } catch {
          skipped += 1;
        }
      }

      return c.json({
        processed: pendingOrders.length,
        filled,
        skipped,
        filledOrderIds,
      });
    }),
  );

  app.delete(
    "/api/orders/:id",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, cancelOrderSchema);
      if (!parsed.success) {
        return parsed.response;
      }

      const orderId = c.req.param("id");
      const userId = c.get("userId");

      const order = await getFirst(db.select().from(orders).where(eq(orders.id, orderId)).limit(1).all());
      if (!order) {
        return jsonError(c, 404, "ORDER_NOT_FOUND", "Order not found");
      }

      if (userId !== "admin") {
        const account = await getUserAccount(userId);
        if (!account) {
          return jsonError(c, 404, "ORDER_NOT_FOUND", "Order not found");
        }
        if (account.id !== order.accountId) {
          return jsonError(c, 404, "ORDER_NOT_FOUND", "Order not found");
        }
      }

      if (order.status !== "pending") {
        return jsonError(c, 400, "INVALID_ORDER", "Only pending orders can be cancelled");
      }

      await db
        .update(orders)
        .set({ status: "cancelled", cancelReasoning: parsed.data.reasoning })
        .where(eq(orders.id, orderId))
        .run();

      return c.json({ id: orderId, status: "cancelled" });
    }),
  );

  app.get(
    "/api/positions",
    withErrorHandling(async (c) => {
      const parsed = parseQuery(c, listPositionsQuerySchema);
      if (!parsed.success) {
        return parsed.response;
      }

      const userId = c.get("userId");
      let rows;
      if (userId === "admin") {
        let whereClause: SQL | undefined;
        if (parsed.data.userId) {
          const accountIds = (
            await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, parsed.data.userId)).all()
          ).map((item) => item.id);
          if (accountIds.length === 0) {
            return c.json({ positions: [] });
          }
          whereClause = inArray(positions.accountId, accountIds);
        }

        rows = await db.select().from(positions).where(whereClause).orderBy(asc(positions.market), asc(positions.symbol)).all();
      } else {
        const account = await getUserAccount(userId);
        if (!account) {
          return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");
        }

        rows = await db
          .select()
          .from(positions)
          .where(eq(positions.accountId, account.id))
          .orderBy(asc(positions.market), asc(positions.symbol))
          .all();
      }

      return c.json({ positions: rows });
    }),
  );

  app.post(
    "/api/journal",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, createJournalSchema);
      if (!parsed.success) {
        return parsed.response;
      }

      const userId = c.get("userId");
      if (!userId || userId === "admin") {
        return jsonError(c, 400, "INVALID_USER", "Invalid user for journal entry");
      }

      const entry = {
        id: makeId("jrn"),
        userId,
        content: parsed.data.content,
        tags: serializeTags(parsed.data.tags),
        createdAt: nowIso(),
      };

      await db.insert(journal).values(entry).run();

      return c.json({ ...entry, tags: deserializeTags(entry.tags) }, 201);
    }),
  );

  app.get(
    "/api/journal",
    withErrorHandling(async (c) => {
      const parsed = parseQuery(c, paginationQuerySchema);
      if (!parsed.success) {
        return parsed.response;
      }

      const userId = c.get("userId");
      if (!userId || userId === "admin") {
        return jsonError(c, 400, "INVALID_USER", "Invalid user for journal listing");
      }

      const q = c.req.query("q")?.trim();
      const tagsQuery = c.req.query("tags")?.trim();
      const tagSet = tagsQuery ? new Set(tagsQuery.split(",").map((item) => item.trim()).filter(Boolean)) : null;

      let rows = await db.select().from(journal).where(eq(journal.userId, userId)).orderBy(desc(journal.createdAt)).all();

      if (q) {
        const lowered = q.toLowerCase();
        rows = rows.filter(
          (row) =>
            row.content.toLowerCase().includes(lowered) ||
            deserializeTags(row.tags).some((tag) => tag.toLowerCase().includes(lowered)),
        );
      }

      if (tagSet) {
        rows = rows.filter((row) => {
          const tags = deserializeTags(row.tags);
          return tags.some((tag) => tagSet.has(tag));
        });
      }

      const paginated = rows.slice(parsed.data.offset, parsed.data.offset + parsed.data.limit);

      return c.json({
        entries: paginated.map((entry) => ({
          ...entry,
          tags: deserializeTags(entry.tags),
        })),
      });
    }),
  );

  app.get(
    "/api/markets",
    withErrorHandling(async (c) => {
      return c.json({ markets: registry.list() });
    }),
  );

  app.get(
    "/api/markets/:market/search",
    withErrorHandling(async (c) => {
      const parsed = parseQuery(c, searchMarketQuerySchema);
      if (!parsed.success) {
        return parsed.response;
      }

      const adapter = registry.get(c.req.param("market"));
      if (!adapter) {
        return jsonError(c, 404, "MARKET_NOT_FOUND", "Market not found");
      }

      if (!adapter.capabilities.includes("search")) {
        return jsonError(c, 400, "CAPABILITY_NOT_SUPPORTED", "search is not supported for this market");
      }

      const results = await adapter.search(parsed.data.q);
      return c.json({ results });
    }),
  );

  app.get(
    "/api/markets/:market/quote",
    withErrorHandling(async (c) => {
      const parsed = parseQuery(c, quoteQuerySchema);
      if (!parsed.success) {
        return parsed.response;
      }

      const adapter = registry.get(c.req.param("market"));
      if (!adapter) {
        return jsonError(c, 404, "MARKET_NOT_FOUND", "Market not found");
      }

      if (!adapter.capabilities.includes("quote")) {
        return jsonError(c, 400, "CAPABILITY_NOT_SUPPORTED", "quote is not supported for this market");
      }

      const quote = await adapter.getQuote(parsed.data.symbol);
      return c.json(quote);
    }),
  );

  app.get(
    "/api/markets/:market/orderbook",
    withErrorHandling(async (c) => {
      const parsed = parseQuery(c, quoteQuerySchema);
      if (!parsed.success) {
        return parsed.response;
      }

      const adapter = registry.get(c.req.param("market"));
      if (!adapter) {
        return jsonError(c, 404, "MARKET_NOT_FOUND", "Market not found");
      }

      if (!adapter.capabilities.includes("orderbook") || typeof adapter.getOrderbook !== "function") {
        return jsonError(c, 400, "CAPABILITY_NOT_SUPPORTED", "orderbook is not supported for this market");
      }

      const orderbook = await adapter.getOrderbook(parsed.data.symbol);
      return c.json(orderbook);
    }),
  );

  app.get(
    "/api/markets/:market/resolve",
    withErrorHandling(async (c) => {
      const parsed = parseQuery(c, quoteQuerySchema);
      if (!parsed.success) {
        return parsed.response;
      }

      const adapter = registry.get(c.req.param("market"));
      if (!adapter) {
        return jsonError(c, 404, "MARKET_NOT_FOUND", "Market not found");
      }

      if (!adapter.capabilities.includes("resolve") || typeof adapter.resolve !== "function") {
        return jsonError(c, 400, "CAPABILITY_NOT_SUPPORTED", "resolve is not supported for this market");
      }

      const resolution = await adapter.resolve(parsed.data.symbol);
      return c.json(resolution ?? { symbol: parsed.data.symbol, resolved: false, outcome: null, settlementPrice: null });
    }),
  );

  app.use("/api/admin/*", adminOnlyMiddleware);

  app.get(
    "/api/admin/overview",
    withErrorHandling(async (c) => {
      const userRows = await db.select().from(users).all();
      const accountRows = await db.select().from(accounts).all();
      const positionRows = await db.select().from(positions).all();

      const accountById = new Map(accountRows.map((account) => [account.id, account]));
      const primaryAccountByUserId = new Map<string, (typeof accountRows)[number]>();
      for (const account of [...accountRows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (!primaryAccountByUserId.has(account.userId)) {
          primaryAccountByUserId.set(account.userId, account);
        }
      }

      const quotePriceByKey = new Map<string, number | null>();
      const quoteTimestampByKey = new Map<string, string | null>();

      for (const row of positionRows) {
        const key = `${row.market}::${row.symbol}`;
        if (quotePriceByKey.has(key)) {
          continue;
        }

        const adapter = registry.get(row.market);
        if (!adapter) {
          quotePriceByKey.set(key, null);
          quoteTimestampByKey.set(key, null);
          continue;
        }

        try {
          const quote = await adapter.getQuote(row.symbol);
          quotePriceByKey.set(key, quote.price);
          quoteTimestampByKey.set(key, quote.timestamp);
        } catch {
          quotePriceByKey.set(key, null);
          quoteTimestampByKey.set(key, null);
        }
      }

      const positionsByAccount = new Map<
        string,
        Array<{
          market: string;
          symbol: string;
          quantity: number;
          avgCost: number;
          currentPrice: number | null;
          marketValue: number | null;
          unrealizedPnl: number | null;
          quoteTimestamp: string | null;
        }>
      >();

      const marketSummaryById = new Map<
        string,
        {
          marketId: string;
          marketName: string;
          users: Set<string>;
          positions: number;
          totalQuantity: number;
          totalMarketValue: number;
          totalUnrealizedPnl: number;
          quotedPositions: number;
          unpricedPositions: number;
        }
      >();

      for (const row of positionRows) {
        const account = accountById.get(row.accountId);
        if (!account) {
          continue;
        }

        const adapter = registry.get(row.market);
        const key = `${row.market}::${row.symbol}`;
        const currentPrice = quotePriceByKey.get(key) ?? null;
        const quoteTimestamp = quoteTimestampByKey.get(key) ?? null;

        const marketValue =
          currentPrice === null ? null : calculateMarketValue({ quantity: row.quantity, avgCost: row.avgCost }, currentPrice);
        const unrealizedPnl =
          currentPrice === null ? null : calculateUnrealizedPnl({ quantity: row.quantity, avgCost: row.avgCost }, currentPrice);

        if (!positionsByAccount.has(row.accountId)) {
          positionsByAccount.set(row.accountId, []);
        }

        positionsByAccount.get(row.accountId)?.push({
          market: row.market,
          symbol: row.symbol,
          quantity: row.quantity,
          avgCost: row.avgCost,
          currentPrice,
          marketValue,
          unrealizedPnl,
          quoteTimestamp,
        });

        if (!marketSummaryById.has(row.market)) {
          marketSummaryById.set(row.market, {
            marketId: row.market,
            marketName: adapter?.displayName ?? row.market,
            users: new Set<string>(),
            positions: 0,
            totalQuantity: 0,
            totalMarketValue: 0,
            totalUnrealizedPnl: 0,
            quotedPositions: 0,
            unpricedPositions: 0,
          });
        }

        const marketSummary = marketSummaryById.get(row.market);
        if (!marketSummary) {
          continue;
        }

        marketSummary.positions += 1;
        marketSummary.totalQuantity += row.quantity;
        marketSummary.users.add(account.userId);

        if (marketValue === null || unrealizedPnl === null) {
          marketSummary.unpricedPositions += 1;
        } else {
          marketSummary.quotedPositions += 1;
          marketSummary.totalMarketValue += marketValue;
          marketSummary.totalUnrealizedPnl += unrealizedPnl;
        }
      }

      const agents = userRows
        .map((user) => {
          const primaryAccount = primaryAccountByUserId.get(user.id) ?? null;
          const agentPositions = [...(primaryAccount ? positionsByAccount.get(primaryAccount.id) ?? [] : [])].sort((a, b) =>
            `${a.market}:${a.symbol}`.localeCompare(`${b.market}:${b.symbol}`),
          );

          const totalBalance = Number((primaryAccount?.balance ?? 0).toFixed(6));
          const totalMarketValue = Number(agentPositions.reduce((sum, position) => sum + (position.marketValue ?? 0), 0).toFixed(6));
          const totalUnrealizedPnl = Number(
            agentPositions.reduce((sum, position) => sum + (position.unrealizedPnl ?? 0), 0).toFixed(6),
          );
          const totalEquity = Number((totalBalance + totalMarketValue).toFixed(6));
          const totalPositions = agentPositions.length;

          return {
            userId: user.id,
            userName: user.name,
            createdAt: user.createdAt,
            accountId: primaryAccount?.id ?? null,
            accountName: primaryAccount?.name ?? null,
            balance: totalBalance,
            positions: agentPositions,
            totals: {
              positions: totalPositions,
              balance: totalBalance,
              marketValue: totalMarketValue,
              unrealizedPnl: totalUnrealizedPnl,
              equity: totalEquity,
            },
          };
        })
        .sort((a, b) => b.totals.equity - a.totals.equity);

      const markets = Array.from(marketSummaryById.values())
        .map((item) => ({
          marketId: item.marketId,
          marketName: item.marketName,
          users: item.users.size,
          positions: item.positions,
          totalQuantity: item.totalQuantity,
          totalMarketValue: Number(item.totalMarketValue.toFixed(6)),
          totalUnrealizedPnl: Number(item.totalUnrealizedPnl.toFixed(6)),
          quotedPositions: item.quotedPositions,
          unpricedPositions: item.unpricedPositions,
        }))
        .sort((a, b) => b.totalMarketValue - a.totalMarketValue);

      const totalBalance = Number(agents.reduce((sum, agent) => sum + agent.totals.balance, 0).toFixed(6));
      const totalMarketValue = Number(markets.reduce((sum, market) => sum + market.totalMarketValue, 0).toFixed(6));
      const totalUnrealizedPnl = Number(markets.reduce((sum, market) => sum + market.totalUnrealizedPnl, 0).toFixed(6));
      const totalEquity = Number((totalBalance + totalMarketValue).toFixed(6));

      return c.json({
        generatedAt: nowIso(),
        totals: {
          users: userRows.length,
          positions: positionRows.length,
          balance: totalBalance,
          marketValue: totalMarketValue,
          unrealizedPnl: totalUnrealizedPnl,
          equity: totalEquity,
        },
        markets,
        agents,
      });
    }),
  );

  app.post(
    "/api/admin/users/:id/deposit",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, adminAmountSchema);
      if (!parsed.success) {
        return parsed.response;
      }

      const userId = c.req.param("id");
      const account = await getUserAccount(userId);
      if (!account) {
        return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");
      }

      const nextBalance = Number((account.balance + parsed.data.amount).toFixed(6));
      await db.update(accounts).set({ balance: nextBalance }).where(eq(accounts.id, account.id)).run();

      return c.json({ balance: nextBalance });
    }),
  );

  app.post(
    "/api/admin/users/:id/withdraw",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, adminAmountSchema);
      if (!parsed.success) {
        return parsed.response;
      }

      const userId = c.req.param("id");
      const account = await getUserAccount(userId);
      if (!account) {
        return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");
      }

      if (account.balance < parsed.data.amount) {
        return jsonError(c, 400, "INSUFFICIENT_BALANCE", "Insufficient balance for withdrawal");
      }

      const nextBalance = Number((account.balance - parsed.data.amount).toFixed(6));
      await db.update(accounts).set({ balance: nextBalance }).where(eq(accounts.id, account.id)).run();

      return c.json({ balance: nextBalance });
    }),
  );

  return app;
};

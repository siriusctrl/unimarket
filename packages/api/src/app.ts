import {
  INITIAL_BALANCE,
  TradingError,
  adminAmountSchema,
  calculateMarketValue,
  calculateUnrealizedPnl,
  cancelOrderSchema,
  createAccountSchema,
  createJournalSchema,
  executeFill,
  listOrdersQuerySchema,
  listPositionsQuerySchema,
  paginationQuerySchema,
  placeOrderSchema,
  quoteQuerySchema,
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

const getOwnedAccount = async (userId: string, accountId: string) => {
  return getFirst(
    db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
      .limit(1)
      .all(),
  );
};

const registry = new MarketRegistry();
registry.register(new PolymarketAdapter());

const createOpenApiDocument = () => {
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
          summary: "Register user and issue first API key",
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
      "/api/accounts": {
        post: {
          summary: "Create account (reasoning required)",
        },
      },
      "/api/accounts/{id}": {
        get: {
          summary: "Get account details",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        },
      },
      "/api/accounts/{id}/portfolio": {
        get: {
          summary: "Get account portfolio",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        },
      },
      "/api/accounts/{id}/timeline": {
        get: {
          summary: "Get account timeline (orders + journal)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        },
      },
      "/api/orders": {
        post: {
          summary: "Place order (reasoning required)",
        },
        get: {
          summary: "List orders",
        },
      },
      "/api/orders/{id}": {
        delete: {
          summary: "Cancel pending order (reasoning required)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        },
      },
      "/api/positions": {
        get: {
          summary: "List positions for account",
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
      "/api/admin/accounts/{id}/deposit": {
        post: {
          summary: "Admin deposit",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        },
      },
      "/api/admin/accounts/{id}/withdraw": {
        post: {
          summary: "Admin withdraw",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        },
      },
    },
  };
};

export const createApp = (): App => {
  const app = new Hono<{ Variables: AppVariables }>();

  app.get("/health", (c) => {
    const descriptors = registry.list();
    const marketStatuses = Object.fromEntries(descriptors.map((item) => [item.id, "available"]));
    return c.json({ status: "ok", markets: marketStatuses });
  });

  app.get("/openapi.json", (c) => {
    return c.json(createOpenApiDocument());
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

      await db.insert(users).values({ id: userId, name: parsed.data.name, createdAt }).run();

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
          name: `${parsed.data.name}-main`,
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

    await authMiddleware(c, next);
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

  app.post(
    "/api/accounts",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, createAccountSchema);
      if (!parsed.success) {
        return parsed.response;
      }

      const userId = c.get("userId");
      if (!userId || userId === "admin") {
        return jsonError(c, 400, "INVALID_USER", "Invalid user for account creation");
      }

      const account = {
        id: makeId("acc"),
        userId,
        balance: INITIAL_BALANCE,
        name: parsed.data.name,
        reasoning: parsed.data.reasoning,
        createdAt: nowIso(),
      };

      await db.insert(accounts).values(account).run();
      return c.json({ id: account.id, name: account.name, balance: account.balance, createdAt: account.createdAt }, 201);
    }),
  );

  app.get(
    "/api/accounts/:id",
    withErrorHandling(async (c) => {
      const accountId = c.req.param("id");
      const userId = c.get("userId");
      const account =
        userId === "admin"
          ? await getFirst(db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1).all())
          : await getOwnedAccount(userId, accountId);

      if (!account) {
        return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");
      }

      return c.json({ id: account.id, name: account.name, balance: account.balance, createdAt: account.createdAt });
    }),
  );

  app.get(
    "/api/accounts/:id/portfolio",
    withErrorHandling(async (c) => {
      const accountId = c.req.param("id");
      const userId = c.get("userId");
      const account =
        userId === "admin"
          ? await getFirst(db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1).all())
          : await getOwnedAccount(userId, accountId);

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
    "/api/accounts/:id/timeline",
    withErrorHandling(async (c) => {
      const accountId = c.req.param("id");
      const userId = c.get("userId");
      const account =
        userId === "admin"
          ? await getFirst(db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1).all())
          : await getOwnedAccount(userId, accountId);

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

      const account = await getOwnedAccount(userId, parsed.data.accountId);
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

      if (parsed.data.type === "limit") {
        await db.insert(orders).values(baseOrder).run();
        return c.json(baseOrder, 201);
      }

      const quote = await adapter.getQuote(parsed.data.symbol);
      const executionPrice = parsed.data.side === "buy" ? (quote.ask ?? quote.price) : (quote.bid ?? quote.price);

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
      const ownedAccounts =
        userId === "admin"
          ? []
          : (await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, userId)).all()).map((item) => item.id);

      const predicates: SQL[] = [];
      if (userId !== "admin") {
        if (ownedAccounts.length === 0) {
          return c.json({ orders: [] });
        }
        predicates.push(inArray(orders.accountId, ownedAccounts));
      }

      if (parsed.data.accountId) {
        predicates.push(eq(orders.accountId, parsed.data.accountId));
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
        const account = await getOwnedAccount(userId, order.accountId);
        if (!account) {
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
      if (userId !== "admin") {
        const account = await getOwnedAccount(userId, parsed.data.accountId);
        if (!account) {
          return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");
        }
      }

      const rows = await db
        .select()
        .from(positions)
        .where(eq(positions.accountId, parsed.data.accountId))
        .orderBy(asc(positions.market), asc(positions.symbol))
        .all();

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

  app.post(
    "/api/admin/accounts/:id/deposit",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, adminAmountSchema);
      if (!parsed.success) {
        return parsed.response;
      }

      const accountId = c.req.param("id");
      const account = await getFirst(db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1).all());
      if (!account) {
        return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");
      }

      const nextBalance = Number((account.balance + parsed.data.amount).toFixed(6));
      await db.update(accounts).set({ balance: nextBalance }).where(eq(accounts.id, accountId)).run();

      return c.json({ balance: nextBalance });
    }),
  );

  app.post(
    "/api/admin/accounts/:id/withdraw",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, adminAmountSchema);
      if (!parsed.success) {
        return parsed.response;
      }

      const accountId = c.req.param("id");
      const account = await getFirst(db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1).all());
      if (!account) {
        return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");
      }

      if (account.balance < parsed.data.amount) {
        return jsonError(c, 400, "INSUFFICIENT_BALANCE", "Insufficient balance for withdrawal");
      }

      const nextBalance = Number((account.balance - parsed.data.amount).toFixed(6));
      await db.update(accounts).set({ balance: nextBalance }).where(eq(accounts.id, accountId)).run();

      return c.json({ balance: nextBalance });
    }),
  );

  return app;
};

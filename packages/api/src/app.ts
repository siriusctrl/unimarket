import { MarketRegistry, PolymarketAdapter } from "@unimarket/markets";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";

import { adminOnlyMiddleware, authMiddleware, type AppVariables } from "./auth.js";
import { createAccountRoutes } from "./routes/account.js";
import { createAdminRoutes } from "./routes/admin.js";
import { auth as authRoutes } from "./routes/auth.js";
import { journalRoutes } from "./routes/journal.js";
import { createMarketRoutes } from "./routes/markets.js";
import { createOrderRoutes } from "./routes/orders.js";
import { positionsRoutes } from "./routes/positions.js";

export type CreateAppOptions = {
  registry?: MarketRegistry;
  webDistPath?: string;
};

export const createDefaultRegistry = (): MarketRegistry => {
  const registry = new MarketRegistry();
  registry.register(new PolymarketAdapter());
  return registry;
};

const createOpenApiDocument = (registry: MarketRegistry) => {
  const marketIds = registry.list().map((market) => market.id);

  return {
    openapi: "3.1.0",
    info: {
      title: "unimarket API",
      version: "0.1.0",
      description: "Polymarket-first, market-agnostic paper trading API",
    },
    servers: [{ url: "http://localhost:3100" }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
    },
    paths: {
      "/health": { get: { summary: "Health check", security: [] } },
      "/openapi.json": { get: { summary: "OpenAPI document", security: [] } },
      "/api/auth/register": { post: { summary: "Register user and issue first API key + default account", security: [] } },
      "/api/auth/keys": { post: { summary: "Create additional API key" } },
      "/api/auth/keys/{id}": { delete: { summary: "Revoke API key", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } },
      "/api/account": { get: { summary: "Get current user's default account" } },
      "/api/account/portfolio": { get: { summary: "Get current user's portfolio" } },
      "/api/account/timeline": { get: { summary: "Get current user's timeline (orders + journal)" } },
      "/api/orders": { get: { summary: "List orders" }, post: { summary: "Place order (reasoning required)" } },
      "/api/orders/reconcile": { post: { summary: "Reconcile and fill marketable pending limit orders (reasoning required)" } },
      "/api/orders/{id}": {
        get: { summary: "Get order by id", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] },
        delete: { summary: "Cancel pending order", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] },
      },
      "/api/positions": { get: { summary: "List positions" } },
      "/api/journal": { get: { summary: "List journal entries" }, post: { summary: "Create journal entry" } },
      "/api/markets": { get: { summary: "List available markets and capabilities" } },
      "/api/markets/{market}/search": { get: { summary: "Search symbols", parameters: [{ name: "market", in: "path", required: true, schema: { type: "string", enum: marketIds } }] } },
      "/api/markets/{market}/quote": { get: { summary: "Get quote", parameters: [{ name: "market", in: "path", required: true, schema: { type: "string", enum: marketIds } }] } },
      "/api/markets/{market}/orderbook": { get: { summary: "Get orderbook", parameters: [{ name: "market", in: "path", required: true, schema: { type: "string", enum: marketIds } }] } },
      "/api/markets/{market}/resolve": { get: { summary: "Get settlement status", parameters: [{ name: "market", in: "path", required: true, schema: { type: "string", enum: marketIds } }] } },
      "/api/admin/accounts/{id}/deposit": { post: { summary: "Admin deposit", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } },
      "/api/admin/users/{id}/deposit": { post: { summary: "Admin deposit to user's default account", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } },
      "/api/admin/users/{id}/withdraw": { post: { summary: "Admin withdraw from user's default account", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } },

      "/api/admin/accounts/{id}/withdraw": { post: { summary: "Admin withdraw", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } },
      "/api/admin/overview": { get: { summary: "Admin portfolio overview" } },
    },
  };
};

export const createApp = (options: CreateAppOptions = {}) => {
  const app = new Hono<{ Variables: AppVariables }>();
  const registry = options.registry ?? createDefaultRegistry();

  app.get("/health", (c) => {
    const marketStatuses = Object.fromEntries(registry.list().map((m) => [m.id, "available"]));
    return c.json({ status: "ok", markets: marketStatuses });
  });

  app.get("/openapi.json", (c) => c.json(createOpenApiDocument(registry)));

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/auth/register") return next();
    return authMiddleware(c, next);
  });

  app.route("/api/auth", authRoutes);

  app.route("/api/account", createAccountRoutes(registry));
  app.route("/api/orders", createOrderRoutes(registry));
  app.route("/api/positions", positionsRoutes);
  app.route("/api/journal", journalRoutes);
  app.route("/api/markets", createMarketRoutes(registry));

  app.use("/api/admin/*", adminOnlyMiddleware);
  app.route("/api/admin", createAdminRoutes(registry));

  // Serve Vite build output as static files
  const webDistRoot = options.webDistPath ?? "../web/dist";
  app.use("/*", serveStatic({ root: webDistRoot }));
  // SPA fallback: serve index.html for non-API, non-file routes
  app.get("/*", serveStatic({ root: webDistRoot, path: "index.html" }));

  return app;
};

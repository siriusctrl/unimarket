import { HyperliquidAdapter, MarketRegistry, PolymarketAdapter } from "@unimarket/markets";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";

import { adminOnlyMiddleware, authMiddleware, type AppVariables } from "./platform/auth.js";
import { createAccountRoutes } from "./routes/account.js";
import { createAdminRoutes } from "./routes/admin.js";
import { auth as authRoutes } from "./routes/auth.js";
import { journalRoutes } from "./routes/journal.js";
import { createMarketRoutes } from "./routes/markets.js";
import { createOrderRoutes } from "./routes/orders.js";
import { eventsRoutes } from "./routes/events.js";
import { positionsRoutes } from "./routes/positions.js";
import { API_VERSION } from "./version.js";
import { jsonError } from "./platform/errors.js";

export type CreateAppOptions = {
  registry?: MarketRegistry;
  webDistPath?: string;
  serveWeb?: boolean;
};

export const createDefaultRegistry = (): MarketRegistry => {
  const registry = new MarketRegistry();
  registry.register(new PolymarketAdapter());
  registry.register(new HyperliquidAdapter());
  return registry;
};

export const createApp = (options: CreateAppOptions = {}) => {
  const app = new Hono<{ Variables: AppVariables }>();
  const registry = options.registry ?? createDefaultRegistry();

  app.use("*", async (c, next) => {
    await next();
    c.header("X-API-Version", API_VERSION);
  });

  app.get("/health", (c) => {
    const marketStatuses = Object.fromEntries(registry.list().map((m) => [m.id, "available"]));
    return c.json({ status: "ok", version: API_VERSION, markets: marketStatuses });
  });

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/auth/register") return next();
    return authMiddleware(c, next);
  });

  app.route("/api/auth", authRoutes);

  app.route("/api/account", createAccountRoutes(registry));
  app.route("/api/events", eventsRoutes);
  app.route("/api/orders", createOrderRoutes(registry));
  app.route("/api/positions", positionsRoutes);
  app.route("/api/journal", journalRoutes);
  app.route("/api/markets", createMarketRoutes(registry));

  app.use("/api/admin/*", adminOnlyMiddleware);
  app.route("/api/admin", createAdminRoutes(registry));
  app.all("/api/*", (c) => jsonError(c, 404, "NOT_FOUND", `API endpoint not found: ${c.req.path}`));

  if (options.serveWeb) {
    // Serve Vite build output as static files
    const webDistRoot = options.webDistPath ?? "../web/dist";
    app.use("/*", serveStatic({ root: webDistRoot }));
    // SPA fallback: serve index.html for non-API, non-file routes
    app.get("/*", serveStatic({ root: webDistRoot, path: "index.html" }));
  }

  return app;
};

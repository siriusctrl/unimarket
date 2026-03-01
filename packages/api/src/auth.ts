import { and, eq, isNull } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";

import { db } from "./db/client.js";
import { apiKeys } from "./db/schema.js";
import { jsonError } from "./errors.js";
import { hashApiKey } from "./utils.js";

export type AppVariables = {
  userId: string;
  apiKeyId: string;
  isAdmin: boolean;
};

const parseBearerToken = (header: string | undefined): string | null => {
  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token;
};

export const authMiddleware: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
  const token = parseBearerToken(c.req.header("Authorization"));
  if (!token) {
    return jsonError(c, 401, "UNAUTHORIZED", "Missing or invalid Authorization header");
  }

  const adminApiKey = process.env.ADMIN_API_KEY;
  if (adminApiKey && token === adminApiKey) {
    c.set("userId", "admin");
    c.set("apiKeyId", "admin");
    c.set("isAdmin", true);
    return next();
  }

  const tokenHash = hashApiKey(token);
  const key = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, tokenHash), isNull(apiKeys.revokedAt)))
    .get();

  if (!key) {
    return jsonError(c, 401, "UNAUTHORIZED", "Invalid API key");
  }

  c.set("userId", key.userId);
  c.set("apiKeyId", key.id);
  c.set("isAdmin", false);

  await next();
};

export const adminOnlyMiddleware: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
  if (!c.get("isAdmin")) {
    return jsonError(c, 403, "FORBIDDEN", "Admin key required");
  }

  await next();
};

import { TradingError } from "@unimarket/core";
import { MarketAdapterError } from "@unimarket/markets";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import type { z } from "zod";

import type { AppVariables } from "./auth.js";
import { db } from "../db/client.js";
import { accounts, users } from "../db/schema.js";
import { jsonError } from "./errors.js";

type AppContext = Context<{ Variables: AppVariables }>;

const getValidationErrorPayload = (
  error: z.ZodError,
): { code: "INVALID_INPUT" | "REASONING_REQUIRED"; message: string } => {
  const reasoningIssue = error.issues.find((issue) => issue.path[0] === "reasoning");
  if (reasoningIssue) {
    return { code: "REASONING_REQUIRED", message: "reasoning is required" };
  }
  return { code: "INVALID_INPUT", message: error.issues[0]?.message ?? "Invalid input" };
};

export const parseJson = async <TSchema extends z.ZodTypeAny>(
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
    return { success: false, response: jsonError(c, 400, issue.code, issue.message) };
  }

  return { success: true, data: parsed.data };
};

export const parseQuery = <TSchema extends z.ZodTypeAny>(
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

export const withErrorHandling = (fn: (c: AppContext) => Promise<Response>) => {
  return async (c: AppContext): Promise<Response> => {
    try {
      return await fn(c);
    } catch (error) {
      if (error instanceof TradingError) {
        return jsonError(c, 400, error.code, error.message);
      }
      if (error instanceof MarketAdapterError) {
        if (error.code === "INVALID_INPUT") {
          return jsonError(c, 400, error.code, error.message);
        }
        if (error.code === "SYMBOL_NOT_FOUND") {
          return jsonError(c, 404, error.code, error.message);
        }
        return jsonError(c, 502, error.code, error.message);
      }
      if (error instanceof Error) {
        return jsonError(c, 500, "INTERNAL_ERROR", error.message);
      }
      return jsonError(c, 500, "INTERNAL_ERROR", "Unknown server error");
    }
  };
};

export const getFirst = async <T>(query: Promise<T[]>): Promise<T | undefined> => {
  const rows = await query;
  return rows[0];
};

export const getUserAccount = async (userId: string) => {
  return db.select().from(accounts).where(eq(accounts.userId, userId)).get();
};

export const getUserRecord = async (userId: string) => {
  return db.select().from(users).where(eq(users.id, userId)).get();
};

export const getUserAccountScope = async (
  userId: string,
  requestedAccountId?: string | null,
): Promise<{ account: Awaited<ReturnType<typeof getUserAccount>>; mismatch: boolean }> => {
  const account = await getUserAccount(userId);
  if (!account) {
    return { account: undefined, mismatch: false };
  }

  if (requestedAccountId && requestedAccountId !== account.id) {
    return { account: undefined, mismatch: true };
  }

  return { account, mismatch: false };
};

export const requireNonAdminUserId = (
  c: AppContext,
  message: string,
): { success: true; userId: string } | { success: false; response: Response } => {
  const userId = c.get("userId");
  if (!userId || userId === "admin") {
    return { success: false, response: jsonError(c, 400, "INVALID_USER", message) };
  }
  return { success: true, userId };
};

export const requireUserRecord = async (
  c: AppContext,
  userId: string,
): Promise<
  | { success: true; user: NonNullable<Awaited<ReturnType<typeof getUserRecord>>> }
  | { success: false; response: Response }
> => {
  const user = await getUserRecord(userId);
  if (!user) {
    return { success: false, response: jsonError(c, 404, "USER_NOT_FOUND", "User not found") };
  }
  return { success: true, user };
};

export const serializeTags = (tags: string[] | undefined): string => JSON.stringify(tags ?? []);

export const parseStoredStringArray = (raw: string, fieldName: string): string[] => {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new TypeError(`Invalid ${fieldName}: expected a JSON array of strings`);
  }

  return parsed;
};

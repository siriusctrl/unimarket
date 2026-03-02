import { TradingError } from "@unimarket/core";
import { MarketAdapterError } from "@unimarket/markets";
import type { Context } from "hono";
import type { z } from "zod";

import type { AppVariables } from "./auth.js";
import { db } from "./db/client.js";
import { accounts } from "./db/schema.js";
import { jsonError } from "./errors.js";
import { asc, eq } from "drizzle-orm";

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

export const serializeTags = (tags: string[] | undefined): string => JSON.stringify(tags ?? []);

export const deserializeTags = (raw: string): string[] => {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
};

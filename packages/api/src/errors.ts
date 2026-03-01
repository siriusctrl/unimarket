import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ApiError = {
  code: string;
  message: string;
};

export const jsonError = (c: Context, status: ContentfulStatusCode, code: string, message: string): Response => {
  return c.json({ error: { code, message } satisfies ApiError }, status);
};

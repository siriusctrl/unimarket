import { z } from "zod";

export const idSchema = z.string().min(1);
export const marketIdSchema = z.string().min(1);
export const symbolSchema = z.string().min(1);

export const reasoningSchema = z.string().trim().min(1, "reasoning is required");

export const sideSchema = z.enum(["buy", "sell"]);
export const orderTypeSchema = z.enum(["market", "limit"]);
export const orderStatusSchema = z.enum(["pending", "filled", "cancelled", "rejected"]);
export const ordersViewSchema = z.enum(["all", "open", "history"]);

export const placeOrderSchema = z
  .object({
    market: marketIdSchema,
    symbol: symbolSchema,
    side: sideSchema,
    type: orderTypeSchema,
    quantity: z.number().int().positive(),
    limitPrice: z.number().positive().optional(),
    reasoning: reasoningSchema,
  })
  .superRefine((value, ctx) => {
    if (value.type === "limit" && typeof value.limitPrice !== "number") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["limitPrice"],
        message: "limitPrice is required for limit orders",
      });
    }
  });

export const cancelOrderSchema = z.object({
  reasoning: reasoningSchema,
});

export const reconcileOrdersSchema = z.object({
  reasoning: reasoningSchema,
});

export const registerSchema = z
  .object({
    userName: z.string().trim().min(1).optional(),
    // Backward compatibility for existing clients.
    name: z.string().trim().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.userName && !value.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["userName"],
        message: "userName is required",
      });
    }
  });

export const createJournalSchema = z.object({
  content: z.string().trim().min(1),
  tags: z.array(z.string().trim().min(1)).optional(),
});

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listOrdersQuerySchema = z.object({
  view: ordersViewSchema.default("all"),
  status: orderStatusSchema.optional(),
  market: marketIdSchema.optional(),
  symbol: symbolSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listPositionsQuerySchema = z.object({
  userId: idSchema.optional(),
});

export const searchMarketQuerySchema = z.object({
  q: z.string().trim().min(1),
});

export const quoteQuerySchema = z.object({
  symbol: symbolSchema,
});

export const adminAmountSchema = z.object({
  amount: z.number().positive(),
});

export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;
export type ReconcileOrdersInput = z.infer<typeof reconcileOrdersSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type CreateJournalInput = z.infer<typeof createJournalSchema>;
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;
export type ListPositionsQuery = z.infer<typeof listPositionsQuerySchema>;
export type SearchMarketQuery = z.infer<typeof searchMarketQuerySchema>;
export type QuoteQuery = z.infer<typeof quoteQuerySchema>;
export type AdminAmountInput = z.infer<typeof adminAmountSchema>;
export type OrderStatus = z.infer<typeof orderStatusSchema>;
export type OrdersView = z.infer<typeof ordersViewSchema>;

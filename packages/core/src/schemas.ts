import { z } from "zod";

export const idSchema = z.string().min(1);
export const marketIdSchema = z.string().min(1);
export const symbolSchema = z.string().min(1);
export const referenceSchema = z.string().min(1);

export const reasoningSchema = z.string().trim().min(1, "reasoning is required");

export const sideSchema = z.enum(["buy", "sell"]);
export const orderTypeSchema = z.enum(["market", "limit"]);
export const orderStatusSchema = z.enum(["pending", "filled", "cancelled", "rejected"]);
export const ordersViewSchema = z.enum(["all", "open", "history"]);

export const orderPredictionSchema = z.object({
  outcome: z.string().trim().min(1),
  probability: z.number().min(0).max(1),
  conviction: z.number().min(0).max(1).optional(),
  thesis: z.string().trim().min(1).optional(),
});

export const placeOrderSchema = z
  .object({
    accountId: idSchema.optional(),
    market: marketIdSchema,
    reference: referenceSchema,
    side: sideSchema,
    type: orderTypeSchema,
    quantity: z.number().positive(),
    limitPrice: z.number().positive().optional(),
    leverage: z.number().positive().max(100).optional(),
    reduceOnly: z.boolean().optional(),
    reasoning: reasoningSchema,
    prediction: orderPredictionSchema.optional(),
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

export const registerSchema = z.object({
  userName: z.string().trim().min(1),
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
  accountId: idSchema.optional(),
  view: ordersViewSchema.default("all"),
  status: orderStatusSchema.optional(),
  market: marketIdSchema.optional(),
  symbol: symbolSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listPositionsQuerySchema = z.object({
  userId: idSchema.optional(),
  accountId: idSchema.optional(),
});

export const searchMarketQuerySchema = z.object({
  q: z.string().trim().min(1),
  sort: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const browseMarketQuerySchema = z.object({
  sort: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const quoteQuerySchema = z.object({
  reference: referenceSchema,
});

const parseReferences = (raw: string): string[] => {
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((reference) => reference.trim())
        .filter((reference) => reference.length > 0),
    ),
  );
};

export const multiQuoteQuerySchema = z.object({
  references: z
    .string()
    .trim()
    .min(1)
    .transform((value) => parseReferences(value))
    .refine((references) => references.length > 0, { message: "references must include at least one value" })
    .refine((references) => references.length <= 50, { message: "references supports up to 50 values" }),
});

export const priceHistoryIntervalSchema = z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]);
export const priceHistoryLookbackSchema = z.enum(["1h", "4h", "1d", "7d", "30d"]);

const dateTimeQuerySchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => Number.isFinite(Date.parse(value)), { message: "must be a valid datetime" });

export const priceHistoryQuerySchema = z.object({
  reference: referenceSchema,
  interval: priceHistoryIntervalSchema.optional(),
  lookback: priceHistoryLookbackSchema.optional(),
  asOf: dateTimeQuerySchema.optional(),
  startTime: dateTimeQuerySchema.optional(),
  endTime: dateTimeQuerySchema.optional(),
}).superRefine((value, ctx) => {
  const hasStart = value.startTime !== undefined;
  const hasEnd = value.endTime !== undefined;
  const usesCustomRange = hasStart || hasEnd;

  if (hasStart !== hasEnd) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "startTime and endTime must be provided together",
      path: hasStart ? ["endTime"] : ["startTime"],
    });
  }

  if (value.lookback && usesCustomRange) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "lookback cannot be combined with startTime/endTime",
      path: ["lookback"],
    });
  }

  if (value.asOf && usesCustomRange) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "asOf cannot be combined with startTime/endTime",
      path: ["asOf"],
    });
  }
});

export const symbolTradesQuerySchema = z.object({
  market: marketIdSchema,
  symbol: symbolSchema,
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export const adminAmountSchema = z.object({
  amount: z.number().positive(),
});

export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;
export type OrderPredictionInput = z.infer<typeof orderPredictionSchema>;
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type CreateJournalInput = z.infer<typeof createJournalSchema>;
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;
export type ListPositionsQuery = z.infer<typeof listPositionsQuerySchema>;
export type SearchMarketQuery = z.infer<typeof searchMarketQuerySchema>;
export type BrowseMarketQuery = z.infer<typeof browseMarketQuerySchema>;
export type QuoteQuery = z.infer<typeof quoteQuerySchema>;
export type MultiQuoteQuery = z.infer<typeof multiQuoteQuerySchema>;
export type PriceHistoryQuery = z.infer<typeof priceHistoryQuerySchema>;
export type SymbolTradesQuery = z.infer<typeof symbolTradesQuerySchema>;
export type AdminAmountInput = z.infer<typeof adminAmountSchema>;
export type OrderStatus = z.infer<typeof orderStatusSchema>;
export type OrdersView = z.infer<typeof ordersViewSchema>;
export type BrowseSort = z.infer<typeof browseMarketQuerySchema>["sort"];

import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
});

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    keyHash: text("key_hash").notNull(),
    prefix: text("prefix").notNull(),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => ({
    keyHashUnique: uniqueIndex("api_keys_key_hash_uq").on(table.keyHash),
    userIdx: index("api_keys_user_id_idx").on(table.userId),
  }),
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    balance: real("balance").notNull(),
    name: text("name").notNull(),
    reasoning: text("reasoning").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    userIdx: index("accounts_user_id_idx").on(table.userId),
  }),
);

export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    market: text("market").notNull(),
    symbol: text("symbol").notNull(),
    side: text("side").notNull(),
    type: text("type").notNull(),
    quantity: integer("quantity").notNull(),
    limitPrice: real("limit_price"),
    status: text("status").notNull(),
    filledPrice: real("filled_price"),
    reasoning: text("reasoning").notNull(),
    cancelReasoning: text("cancel_reasoning"),
    filledAt: text("filled_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    accountIdx: index("orders_account_id_idx").on(table.accountId),
    marketIdx: index("orders_market_idx").on(table.market),
    statusIdx: index("orders_status_idx").on(table.status),
  }),
);

export const positions = sqliteTable(
  "positions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    market: text("market").notNull(),
    symbol: text("symbol").notNull(),
    quantity: integer("quantity").notNull(),
    avgCost: real("avg_cost").notNull(),
  },
  (table) => ({
    uniquePosition: uniqueIndex("positions_unique_idx").on(table.accountId, table.market, table.symbol),
    accountIdx: index("positions_account_id_idx").on(table.accountId),
  }),
);

export const trades = sqliteTable(
  "trades",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
    accountId: text("account_id").notNull(),
    market: text("market").notNull(),
    symbol: text("symbol").notNull(),
    side: text("side").notNull(),
    quantity: integer("quantity").notNull(),
    price: real("price").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    accountIdx: index("trades_account_id_idx").on(table.accountId),
    orderIdx: index("trades_order_id_idx").on(table.orderId),
  }),
);

export const journal = sqliteTable(
  "journal",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    content: text("content").notNull(),
    tags: text("tags").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    userIdx: index("journal_user_id_idx").on(table.userId),
  }),
);

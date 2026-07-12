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
  (table) => [
    uniqueIndex("api_keys_key_hash_uq").on(table.keyHash),
    index("api_keys_user_id_idx").on(table.userId),
  ],
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
  (table) => [
    uniqueIndex("accounts_user_id_uq").on(table.userId),
    index("accounts_user_id_idx").on(table.userId),
  ],
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
    quantity: real("quantity").notNull(),
    limitPrice: real("limit_price"),
    status: text("status").notNull(),
    filledPrice: real("filled_price"),
    reasoning: text("reasoning").notNull(),
    cancelReasoning: text("cancel_reasoning"),
    cancelledAt: text("cancelled_at"),
    filledAt: text("filled_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("orders_account_id_idx").on(table.accountId),
    index("orders_market_idx").on(table.market),
    index("orders_status_idx").on(table.status),
  ],
);

export const orderExecutionParams = sqliteTable(
  "order_execution_params",
  {
    orderId: text("order_id").primaryKey(),
    leverage: real("leverage").notNull(),
    reduceOnly: integer("reduce_only", { mode: "boolean" }).notNull(),
    takerFeeRate: real("taker_fee_rate").notNull().default(0),
  },
  (table) => [
    index("order_execution_params_leverage_idx").on(table.leverage),
  ],
);

export const positions = sqliteTable(
  "positions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    market: text("market").notNull(),
    symbol: text("symbol").notNull(),
    quantity: real("quantity").notNull(),
    avgCost: real("avg_cost").notNull(),
  },
  (table) => [
    uniqueIndex("positions_unique_idx").on(table.accountId, table.market, table.symbol),
    index("positions_account_id_idx").on(table.accountId),
  ],
);

export const perpPositionState = sqliteTable(
  "perp_position_state",
  {
    positionId: text("position_id").primaryKey(),
    accountId: text("account_id").notNull(),
    market: text("market").notNull(),
    symbol: text("symbol").notNull(),
    leverage: real("leverage").notNull(),
    margin: real("margin").notNull(),
    maintenanceMarginRatio: real("maintenance_margin_ratio").notNull(),
    liquidationPrice: real("liquidation_price"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("perp_position_state_account_id_idx").on(table.accountId),
    index("perp_position_state_market_symbol_idx").on(table.market, table.symbol),
  ],
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
    quantity: real("quantity").notNull(),
    price: real("price").notNull(),
    fee: real("fee").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("trades_account_id_idx").on(table.accountId),
    index("trades_order_id_idx").on(table.orderId),
  ],
);

export const predictions = sqliteTable(
  "predictions",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
    accountId: text("account_id").notNull(),
    userId: text("user_id").notNull(),
    market: text("market").notNull(),
    symbol: text("symbol").notNull(),
    side: text("side").notNull(),
    outcome: text("outcome").notNull(),
    probability: real("probability").notNull(),
    conviction: real("conviction"),
    thesis: text("thesis"),
    entryPrice: real("entry_price"),
    submittedAt: text("submitted_at").notNull(),
  },
  (table) => [
    uniqueIndex("predictions_order_id_uq").on(table.orderId),
    index("predictions_user_id_idx").on(table.userId),
    index("predictions_account_market_symbol_idx").on(table.accountId, table.market, table.symbol),
    index("predictions_submitted_at_idx").on(table.submittedAt),
  ],
);

export const predictionScores = sqliteTable(
  "prediction_scores",
  {
    id: text("id").primaryKey(),
    predictionId: text("prediction_id").notNull(),
    orderId: text("order_id").notNull(),
    accountId: text("account_id").notNull(),
    userId: text("user_id").notNull(),
    market: text("market").notNull(),
    symbol: text("symbol").notNull(),
    metric: text("metric").notNull(),
    version: text("version").notNull(),
    value: real("value").notNull(),
    details: text("details").notNull(),
    scoredAt: text("scored_at").notNull(),
  },
  (table) => [
    uniqueIndex("prediction_scores_metric_version_uq").on(table.predictionId, table.metric, table.version),
    index("prediction_scores_user_metric_idx").on(table.userId, table.metric),
    index("prediction_scores_order_id_idx").on(table.orderId),
  ],
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
  (table) => [
    index("journal_user_id_idx").on(table.userId),
  ],
);

export const equitySnapshots = sqliteTable(
  "equity_snapshots",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    balance: real("balance").notNull(),
    marketValue: real("market_value").notNull(),
    equity: real("equity").notNull(),
    unrealizedPnl: real("unrealized_pnl").notNull(),
    snapshotAt: text("snapshot_at").notNull(),
  },
  (table) => [
    index("equity_snapshots_user_time_idx").on(table.userId, table.snapshotAt),
  ],
);

export const symbolMetadataCache = sqliteTable(
  "symbol_metadata_cache",
  {
    market: text("market").notNull(),
    symbol: text("symbol").notNull(),
    symbolName: text("symbol_name"),
    outcome: text("outcome"),
    fetchedAt: text("fetched_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastError: text("last_error"),
  },
  (table) => [
    uniqueIndex("symbol_metadata_cache_market_symbol_uq").on(table.market, table.symbol),
    index("symbol_metadata_cache_market_expires_idx").on(table.market, table.expiresAt),
  ],
);

export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    key: text("key").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    requestHash: text("request_hash").notNull(),
    status: integer("status").notNull(),
    responseBody: text("response_body").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idempotency_keys_unique_scope_uq").on(
      table.userId,
      table.key,
      table.method,
      table.path,
    ),
    index("idempotency_keys_created_at_idx").on(table.createdAt),
  ],
);

export const fundingPayments = sqliteTable(
  "funding_payments",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    market: text("market").notNull(),
    symbol: text("symbol").notNull(),
    quantity: real("quantity").notNull(),
    fundingRate: real("funding_rate").notNull(),
    payment: real("payment").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("funding_payments_account_id_idx").on(table.accountId),
    index("funding_payments_market_symbol_idx").on(table.market, table.symbol),
  ],
);

export const liquidations = sqliteTable(
  "liquidations",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
    accountId: text("account_id").notNull(),
    market: text("market").notNull(),
    symbol: text("symbol").notNull(),
    side: text("side").notNull(),
    quantity: real("quantity").notNull(),
    leverage: real("leverage").notNull(),
    margin: real("margin").notNull(),
    maintenanceMarginRatio: real("maintenance_margin_ratio").notNull(),
    triggerPrice: real("trigger_price").notNull(),
    executionPrice: real("execution_price").notNull(),
    triggerPositionEquity: real("trigger_position_equity").notNull(),
    maintenanceMargin: real("maintenance_margin").notNull(),
    grossPayout: real("gross_payout").notNull(),
    feeCharged: real("fee_charged").notNull(),
    netPayout: real("net_payout").notNull(),
    reasoning: text("reasoning").notNull(),
    cancelledReduceOnlyOrderIds: text("cancelled_reduce_only_order_ids").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("liquidations_account_id_idx").on(table.accountId),
    index("liquidations_order_id_idx").on(table.orderId),
    index("liquidations_market_symbol_idx").on(table.market, table.symbol),
    index("liquidations_created_at_idx").on(table.createdAt),
  ],
);

export const chartAnalyses = sqliteTable(
  "chart_analyses",
  {
    id: text("id").primaryKey(),
    supersedesId: text("supersedes_id"),
    version: integer("version").notNull(),
    revision: integer("revision").notNull().default(1),
    status: text("status").notNull(),
    market: text("market").notNull(),
    reference: text("reference").notNull(),
    interval: text("interval").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    document: text("document").notNull(),
    createdBy: text("created_by").notNull(),
    reasoning: text("reasoning").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    publishedAt: text("published_at"),
  },
  (table) => [
    index("chart_analyses_instrument_idx").on(table.market, table.reference, table.createdAt),
    index("chart_analyses_status_idx").on(table.status),
    index("chart_analyses_created_by_idx").on(table.createdBy),
    index("chart_analyses_lookup_idx").on(table.market, table.reference, table.interval, table.status, table.createdAt),
  ],
);

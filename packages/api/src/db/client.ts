import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import * as schema from "./schema.js";

const rawDbUrl = process.env.DB_URL ?? process.env.DB_PATH ?? "file:unimarket.sqlite";
const dbUrl = rawDbUrl.includes(":") ? rawDbUrl : `file:${rawDbUrl}`;

export const sqlite = createClient({ url: dbUrl });
export const db = drizzle(sqlite, { schema });

const migrationStatements = [
  `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  )
  `,
  `CREATE INDEX IF NOT EXISTS api_keys_user_id_idx ON api_keys(user_id)`,
  `
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    balance REAL NOT NULL,
    name TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
  `,
  `CREATE INDEX IF NOT EXISTS accounts_user_id_idx ON accounts(user_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS accounts_user_id_uq ON accounts(user_id)`,
  `
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    market TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    type TEXT NOT NULL,
    quantity REAL NOT NULL,
    limit_price REAL,
    status TEXT NOT NULL,
    filled_price REAL,
    reasoning TEXT NOT NULL,
    cancel_reasoning TEXT,
    cancelled_at TEXT,
    filled_at TEXT,
    created_at TEXT NOT NULL
  )
  `,
  `CREATE INDEX IF NOT EXISTS orders_account_id_idx ON orders(account_id)`,
  `CREATE INDEX IF NOT EXISTS orders_market_idx ON orders(market)`,
  `CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status)`,
  `
  CREATE TABLE IF NOT EXISTS order_execution_params (
    order_id TEXT PRIMARY KEY,
    leverage REAL NOT NULL,
    reduce_only INTEGER NOT NULL,
    taker_fee_rate REAL NOT NULL DEFAULT 0
  )
  `,
  `CREATE INDEX IF NOT EXISTS order_execution_params_leverage_idx ON order_execution_params(leverage)`,
  `
  CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    market TEXT NOT NULL,
    symbol TEXT NOT NULL,
    quantity REAL NOT NULL,
    avg_cost REAL NOT NULL
  )
  `,
  `CREATE UNIQUE INDEX IF NOT EXISTS positions_unique_idx ON positions(account_id, market, symbol)`,
  `CREATE INDEX IF NOT EXISTS positions_account_id_idx ON positions(account_id)`,
  `
  CREATE TABLE IF NOT EXISTS perp_position_state (
    position_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    market TEXT NOT NULL,
    symbol TEXT NOT NULL,
    leverage REAL NOT NULL,
    margin REAL NOT NULL,
    maintenance_margin_ratio REAL NOT NULL,
    liquidation_price REAL,
    updated_at TEXT NOT NULL
  )
  `,
  `CREATE INDEX IF NOT EXISTS perp_position_state_account_id_idx ON perp_position_state(account_id)`,
  `CREATE INDEX IF NOT EXISTS perp_position_state_market_symbol_idx ON perp_position_state(market, symbol)`,
  `
  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    market TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    quantity REAL NOT NULL,
    price REAL NOT NULL,
    fee REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )
  `,
  `CREATE INDEX IF NOT EXISTS trades_account_id_idx ON trades(account_id)`,
  `CREATE INDEX IF NOT EXISTS trades_order_id_idx ON trades(order_id)`,
  `
  CREATE TABLE IF NOT EXISTS journal (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
  `,
  `CREATE INDEX IF NOT EXISTS journal_user_id_idx ON journal(user_id)`,
  `
  CREATE TABLE IF NOT EXISTS equity_snapshots (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    balance REAL NOT NULL,
    market_value REAL NOT NULL,
    equity REAL NOT NULL,
    unrealized_pnl REAL NOT NULL,
    snapshot_at TEXT NOT NULL
  )
  `,
  `CREATE INDEX IF NOT EXISTS equity_snapshots_user_time_idx ON equity_snapshots(user_id, snapshot_at)`,
  `
  CREATE TABLE IF NOT EXISTS symbol_metadata_cache (
    market TEXT NOT NULL,
    symbol TEXT NOT NULL,
    symbol_name TEXT,
    outcome TEXT,
    fetched_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_error TEXT
  )
  `,
  `CREATE UNIQUE INDEX IF NOT EXISTS symbol_metadata_cache_market_symbol_uq ON symbol_metadata_cache(market, symbol)`,
  `CREATE INDEX IF NOT EXISTS symbol_metadata_cache_market_expires_idx ON symbol_metadata_cache(market, expires_at)`,
  `
  CREATE TABLE IF NOT EXISTS idempotency_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status INTEGER NOT NULL,
    response_body TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
  `,
  `CREATE UNIQUE INDEX IF NOT EXISTS idempotency_keys_unique_scope_uq ON idempotency_keys(user_id, key, method, path)`,
  `CREATE INDEX IF NOT EXISTS idempotency_keys_created_at_idx ON idempotency_keys(created_at)`,
  `
  CREATE TABLE IF NOT EXISTS funding_payments (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    market TEXT NOT NULL,
    symbol TEXT NOT NULL,
    quantity REAL NOT NULL,
    funding_rate REAL NOT NULL,
    payment REAL NOT NULL,
    created_at TEXT NOT NULL
  )
  `,
  `CREATE INDEX IF NOT EXISTS funding_payments_account_id_idx ON funding_payments(account_id)`,
  `CREATE INDEX IF NOT EXISTS funding_payments_market_symbol_idx ON funding_payments(market, symbol)`,
];

const additiveMigrationStatements = [
  `ALTER TABLE order_execution_params ADD COLUMN taker_fee_rate REAL NOT NULL DEFAULT 0`,
  `ALTER TABLE trades ADD COLUMN fee REAL NOT NULL DEFAULT 0`,
];

const isDuplicateColumnError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return error.message.toLowerCase().includes("duplicate column name");
};

export const migrate = async (): Promise<void> => {
  for (const statement of migrationStatements) {
    await sqlite.execute(statement);
  }

  for (const statement of additiveMigrationStatements) {
    try {
      await sqlite.execute(statement);
    } catch (error) {
      if (!isDuplicateColumnError(error)) {
        throw error;
      }
    }
  }
};

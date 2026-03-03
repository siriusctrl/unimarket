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
    quantity INTEGER NOT NULL,
    limit_price REAL,
    status TEXT NOT NULL,
    filled_price REAL,
    reasoning TEXT NOT NULL,
    cancel_reasoning TEXT,
    filled_at TEXT,
    created_at TEXT NOT NULL
  )
  `,
  `CREATE INDEX IF NOT EXISTS orders_account_id_idx ON orders(account_id)`,
  `CREATE INDEX IF NOT EXISTS orders_market_idx ON orders(market)`,
  `CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status)`,
  `
  CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    market TEXT NOT NULL,
    symbol TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    avg_cost REAL NOT NULL
  )
  `,
  `CREATE UNIQUE INDEX IF NOT EXISTS positions_unique_idx ON positions(account_id, market, symbol)`,
  `CREATE INDEX IF NOT EXISTS positions_account_id_idx ON positions(account_id)`,
  `
  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    market TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    price REAL NOT NULL,
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
];

export const migrate = async (): Promise<void> => {
  for (const statement of migrationStatements) {
    await sqlite.execute(statement);
  }
};

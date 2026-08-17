import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sourceSyncs = sqliteTable("source_syncs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source").notNull(),
  endpoint: text("endpoint").notNull(),
  status: text("status").notNull(),
  officialDate: text("official_date"),
  fetchedAt: text("fetched_at").notNull(),
  rowCount: integer("row_count").notNull().default(0),
  checksum: text("checksum"),
  error: text("error"),
}, (table) => [index("source_sync_source_time_idx").on(table.source, table.fetchedAt)]);

export const stockSnapshots = sqliteTable("stock_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  market: text("market").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  tradingDate: text("trading_date").notNull(),
  open: real("open"),
  high: real("high"),
  low: real("low"),
  close: real("close"),
  change: real("change"),
  volume: integer("volume"),
  tradeValue: real("trade_value"),
  source: text("source").notNull(),
  fetchedAt: text("fetched_at").notNull(),
}, (table) => [
  uniqueIndex("stock_snapshot_market_code_date_uq").on(table.market, table.code, table.tradingDate),
  index("stock_snapshot_code_date_idx").on(table.code, table.tradingDate),
]);

export const modelRuns = sqliteTable("model_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  version: text("version").notNull(),
  horizon: integer("horizon").notNull(),
  trainStart: text("train_start"),
  trainEnd: text("train_end"),
  testStart: text("test_start"),
  testEnd: text("test_end"),
  sampleCount: integer("sample_count").notNull().default(0),
  brierScore: real("brier_score"),
  calibrationError: real("calibration_error"),
  afterCostReturn: real("after_cost_return"),
  maxDrawdown: real("max_drawdown"),
  status: text("status").notNull().default("building"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("model_runs_horizon_time_idx").on(table.horizon, table.createdAt)]);

export const watchlist = sqliteTable("watchlist", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerKey: text("owner_key").notNull(),
  code: text("code").notNull(),
  market: text("market").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("watchlist_owner_stock_uq").on(table.ownerKey, table.market, table.code)]);

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

export const backfillJobs = sqliteTable("backfill_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  version: text("version").notNull(),
  targetStart: text("target_start").notNull(),
  targetEnd: text("target_end").notNull(),
  cursorDate: text("cursor_date").notNull(),
  cursorMarket: text("cursor_market").notNull(),
  status: text("status").notNull().default("running"),
  processedUnits: integer("processed_units").notNull().default(0),
  totalUnits: integer("total_units").notNull(),
  storedRows: integer("stored_rows").notNull().default(0),
  emptyUnits: integer("empty_units").notNull().default(0),
  failedUnits: integer("failed_units").notNull().default(0),
  startedAt: text("started_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [index("backfill_jobs_status_time_idx").on(table.status, table.updatedAt)]);

export const backfillRunner = sqliteTable("backfill_runner", {
  id: integer("id").primaryKey(),
  status: text("status").notNull().default("idle"),
  leaseToken: text("lease_token"),
  leaseUntil: text("lease_until"),
  lastStartedAt: text("last_started_at"),
  lastHeartbeatAt: text("last_heartbeat_at"),
  lastFinishedAt: text("last_finished_at"),
  completedBatches: integer("completed_batches").notNull().default(0),
  completedUnits: integer("completed_units").notNull().default(0),
  lastError: text("last_error"),
});

export const historicalObservations = sqliteTable("historical_observations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  market: text("market").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  tradingDate: text("trading_date").notNull(),
  securityType: text("security_type").notNull(),
  universeStatus: text("universe_status").notNull(),
  open: real("open"),
  high: real("high"),
  low: real("low"),
  close: real("close"),
  change: real("change"),
  volume: integer("volume"),
  tradeValue: real("trade_value"),
  source: text("source").notNull(),
  sourceScope: text("source_scope").notNull(),
  usableFrom: text("usable_from").notNull(),
  ingestedAt: text("ingested_at").notNull(),
  backfillJobId: integer("backfill_job_id").notNull(),
}, (table) => [
  uniqueIndex("historical_observation_market_code_date_uq").on(table.market, table.code, table.tradingDate),
  index("historical_observation_date_market_idx").on(table.tradingDate, table.market),
  index("historical_observation_usable_idx").on(table.usableFrom, table.securityType),
]);

export const backfillFailures = sqliteTable("backfill_failures", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  backfillJobId: integer("backfill_job_id").notNull(),
  market: text("market").notNull(),
  tradingDate: text("trading_date").notNull(),
  source: text("source").notNull(),
  error: text("error").notNull(),
  attempts: integer("attempts").notNull().default(1),
  status: text("status").notNull().default("open"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("backfill_failure_job_market_date_uq").on(table.backfillJobId, table.market, table.tradingDate),
  index("backfill_failure_status_idx").on(table.status, table.updatedAt),
]);

export const biasAudits = sqliteTable("bias_audits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  backfillJobId: integer("backfill_job_id").notNull(),
  market: text("market").notNull(),
  tradingDate: text("trading_date").notNull(),
  auditType: text("audit_type").notNull(),
  status: text("status").notNull(),
  checkedRows: integer("checked_rows").notNull().default(0),
  violations: integer("violations").notNull().default(0),
  rule: text("rule").notNull(),
  checkedAt: text("checked_at").notNull(),
}, (table) => [
  uniqueIndex("bias_audit_job_market_date_type_uq").on(table.backfillJobId, table.market, table.tradingDate, table.auditType),
  index("bias_audit_status_idx").on(table.auditType, table.status),
]);

export const watchlist = sqliteTable("watchlist", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerKey: text("owner_key").notNull(),
  code: text("code").notNull(),
  market: text("market").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("watchlist_owner_stock_uq").on(table.ownerKey, table.market, table.code)]);

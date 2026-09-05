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
  phase: text("phase").notNull().default("raw_history"),
  estimatedTotalRows: integer("estimated_total_rows").notNull().default(0),
  lastBatchId: text("last_batch_id"),
  lastBatchRows: integer("last_batch_rows").notNull().default(0),
  lastCheckpointAt: text("last_checkpoint_at"),
  apiRetryCount: integer("api_retry_count").notNull().default(0),
  throttledMs: integer("throttled_ms").notNull().default(0),
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
  activeRuntimeMs: integer("active_runtime_ms").notNull().default(0),
  lastBatchRows: integer("last_batch_rows").notNull().default(0),
  lastBatchDurationMs: integer("last_batch_duration_ms").notNull().default(0),
  recentRowsPerSecond: real("recent_rows_per_second").notNull().default(0),
  apiRetryCount: integer("api_retry_count").notNull().default(0),
  throttledMs: integer("throttled_ms").notNull().default(0),
  networkMs: integer("network_ms").notNull().default(0),
  parseMs: integer("parse_ms").notNull().default(0),
  dbWriteMs: integer("db_write_ms").notNull().default(0),
  workerWaitMs: integer("worker_wait_ms").notNull().default(0),
  rateLimited: integer("rate_limited").notNull().default(0),
  checkpointStatus: text("checkpoint_status").notNull().default("not_started"),
  automationEnabled: integer("automation_enabled").notNull().default(1),
  schedulerIntervalMinutes: integer("scheduler_interval_minutes").notNull().default(1),
  schedulerLastTriggeredAt: text("scheduler_last_triggered_at"),
  schedulerNextExpectedAt: text("scheduler_next_expected_at"),
  lastTriggerSource: text("last_trigger_source").notNull().default("manual"),
  lastError: text("last_error"),
});

export const backfillBatches = sqliteTable("backfill_batches", {
  batchId: text("batch_id").primaryKey(),
  backfillJobId: integer("backfill_job_id").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  status: text("status").notNull(),
  completedUnits: integer("completed_units").notNull().default(0),
  rowsFetched: integer("rows_fetched").notNull().default(0),
  rowsWritten: integer("rows_written").notNull().default(0),
  networkMs: integer("network_ms").notNull().default(0),
  parseMs: integer("parse_ms").notNull().default(0),
  dbWriteMs: integer("db_write_ms").notNull().default(0),
  apiRetryCount: integer("api_retry_count").notNull().default(0),
  throttledMs: integer("throttled_ms").notNull().default(0),
  workerWaitMs: integer("worker_wait_ms").notNull().default(0),
  featureMs: integer("feature_ms").notNull().default(0),
  error: text("error"),
}, (table) => [index("backfill_batches_job_time_idx").on(table.backfillJobId, table.startedAt)]);

export const backfillCheckpoints = sqliteTable("backfill_checkpoints", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  backfillJobId: integer("backfill_job_id").notNull(),
  market: text("market").notNull(),
  tradingDate: text("trading_date").notNull(),
  status: text("status").notNull(),
  batchId: text("batch_id").notNull(),
  rowsFetched: integer("rows_fetched").notNull().default(0),
  rowsWritten: integer("rows_written").notNull().default(0),
  attempts: integer("attempts").notNull().default(1),
  lastError: text("last_error"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("backfill_checkpoint_job_market_date_uq").on(table.backfillJobId, table.market, table.tradingDate),
  index("backfill_checkpoint_status_idx").on(table.status, table.updatedAt),
]);

export const historicalSnapshotImports = sqliteTable("historical_snapshot_imports", {
  id: integer("id").primaryKey(),
  snapshotVersion: text("snapshot_version").notNull(),
  manifestUrl: text("manifest_url").notNull(),
  cutoffDate: text("cutoff_date").notNull(),
  status: text("status").notNull().default("pending"),
  expectedRows: integer("expected_rows").notNull(),
  importedRows: integer("imported_rows").notNull().default(0),
  nextChunk: integer("next_chunk").notNull().default(0),
  totalChunks: integer("total_chunks").notNull(),
  sqliteSha256: text("sqlite_sha256").notNull(),
  lastError: text("last_error"),
  startedAt: text("started_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
});

export const historicalSnapshotChunks = sqliteTable("historical_snapshot_chunks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  snapshotVersion: text("snapshot_version").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  status: text("status").notNull(),
  rowsWritten: integer("rows_written").notNull().default(0),
  sha256: text("sha256").notNull(),
  importedAt: text("imported_at").notNull(),
}, (table) => [uniqueIndex("historical_snapshot_version_chunk_uq").on(table.snapshotVersion, table.chunkIndex)]);

export const dailyIncrementalRuns = sqliteTable("daily_incremental_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  market: text("market").notNull(),
  tradingDate: text("trading_date").notNull(),
  status: text("status").notNull(),
  rowsWritten: integer("rows_written").notNull().default(0),
  attempts: integer("attempts").notNull().default(1),
  lastError: text("last_error"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("daily_incremental_market_date_uq").on(table.market, table.tradingDate)]);

export const historicalSecurities = sqliteTable("historical_securities", {
  market: text("market").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  securityType: text("security_type").notNull(),
  firstSeen: text("first_seen").notNull(),
  lastSeen: text("last_seen").notNull(),
}, (table) => [uniqueIndex("historical_security_market_code_uq").on(table.market, table.code)]);

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

export const operationalGenerations = sqliteTable("operational_generations", {
  generationId: text("generation_id").primaryKey(),
  snapshotVersion: text("snapshot_version").notNull(),
  sourceSha256: text("source_sha256").notNull(),
  baseLastDate: text("base_last_date").notNull(),
  status: text("status").notNull().default("shadow"),
  retentionTradingDays: integer("retention_trading_days").notNull(),
  expectedBars: integer("expected_bars").notNull(),
  expectedQuotes: integer("expected_quotes").notNull(),
  expectedChunks: integer("expected_chunks").notNull(),
  chunkRows: integer("chunk_rows").notNull().default(900),
  importedBars: integer("imported_bars").notNull().default(0),
  importedQuotes: integer("imported_quotes").notNull().default(0),
  importedChunks: integer("imported_chunks").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  activatedAt: text("activated_at"),
  lastError: text("last_error"),
}, (table) => [index("operational_generation_status_idx").on(table.status, table.updatedAt)]);

export const operationalState = sqliteTable("operational_state", {
  id: integer("id").primaryKey(),
  activeGeneration: text("active_generation"),
  retentionTradingDays: integer("retention_trading_days").notNull().default(300),
  policyVersion: text("policy_version").notNull(),
  strategyMaxLookback: integer("strategy_max_lookback").notNull(),
  forecastMaxHorizon: integer("forecast_max_horizon").notNull(),
  safetyBufferDays: integer("safety_buffer_days").notNull(),
  latestCompletedDate: text("latest_completed_date"),
  freshnessStatus: text("freshness_status").notNull().default("rebuilding"),
  lastIncrementalAt: text("last_incremental_at"),
  updatedAt: text("updated_at").notNull(),
});

export const operationalSecurities = sqliteTable("operational_securities", {
  generationId: text("generation_id").notNull(),
  market: text("market").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  securityType: text("security_type").notNull(),
  firstSeen: text("first_seen").notNull(),
  lastSeen: text("last_seen").notNull(),
}, (table) => [
  uniqueIndex("operational_security_generation_market_code_uq").on(table.generationId, table.market, table.code),
  index("operational_security_search_idx").on(table.generationId, table.code, table.name),
]);

export const operationalDailyBars = sqliteTable("operational_daily_bars", {
  generationId: text("generation_id").notNull(),
  market: text("market").notNull(),
  code: text("code").notNull(),
  tradingDate: text("trading_date").notNull(),
  open: real("open"),
  high: real("high"),
  low: real("low"),
  close: real("close"),
  change: real("change"),
  volume: integer("volume"),
  tradeValue: real("trade_value"),
  source: text("source").notNull(),
  ingestedAt: text("ingested_at").notNull(),
}, (table) => [
  uniqueIndex("operational_bar_generation_market_code_date_uq").on(table.generationId, table.market, table.code, table.tradingDate),
  index("operational_bar_generation_date_idx").on(table.generationId, table.tradingDate),
  index("operational_bar_generation_code_date_idx").on(table.generationId, table.market, table.code, table.tradingDate),
]);

export const operationalLatestQuotes = sqliteTable("operational_latest_quotes", {
  generationId: text("generation_id").notNull(),
  market: text("market").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  securityType: text("security_type").notNull(),
  tradingDate: text("trading_date").notNull(),
  open: real("open"),
  high: real("high"),
  low: real("low"),
  close: real("close"),
  change: real("change"),
  volume: integer("volume"),
  tradeValue: real("trade_value"),
  source: text("source").notNull(),
  ingestedAt: text("ingested_at").notNull(),
}, (table) => [
  uniqueIndex("operational_quote_generation_market_code_uq").on(table.generationId, table.market, table.code),
  index("operational_quote_generation_code_name_idx").on(table.generationId, table.code, table.name),
]);

export const operationalMarketIndices = sqliteTable("operational_market_indices", {
  generationId: text("generation_id").notNull(),
  indexCode: text("index_code").notNull(),
  indexName: text("index_name").notNull(),
  tradingDate: text("trading_date").notNull(),
  close: real("close"),
  change: real("change"),
  changePercent: real("change_percent"),
  source: text("source").notNull(),
  fetchedAt: text("fetched_at").notNull(),
}, (table) => [uniqueIndex("operational_index_generation_code_uq").on(table.generationId, table.indexCode)]);

export const operationalIngestionUnits = sqliteTable("operational_ingestion_units", {
  generationId: text("generation_id").notNull(),
  market: text("market").notNull(),
  tradingDate: text("trading_date").notNull(),
  status: text("status").notNull(),
  rowsFetched: integer("rows_fetched").notNull().default(0),
  rowsStored: integer("rows_stored").notNull().default(0),
  sourceChecksum: text("source_checksum"),
  attempts: integer("attempts").notNull().default(1),
  lastError: text("last_error"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("operational_unit_generation_market_date_uq").on(table.generationId, table.market, table.tradingDate),
  index("operational_unit_generation_status_idx").on(table.generationId, table.status, table.tradingDate),
]);

export const operationalImportChunks = sqliteTable("operational_import_chunks", {
  generationId: text("generation_id").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  sha256: text("sha256").notNull(),
  barsWritten: integer("bars_written").notNull(),
  quotesWritten: integer("quotes_written").notNull(),
  sourceKind: text("source_kind"),
  sourceLastId: integer("source_last_id"),
  importedAt: text("imported_at").notNull(),
}, (table) => [uniqueIndex("operational_chunk_generation_index_uq").on(table.generationId, table.chunkIndex)]);

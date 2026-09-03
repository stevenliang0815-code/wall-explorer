CREATE TABLE `operational_daily_bars` (
	`generation_id` text NOT NULL,
	`market` text NOT NULL,
	`code` text NOT NULL,
	`trading_date` text NOT NULL,
	`open` real,
	`high` real,
	`low` real,
	`close` real,
	`change` real,
	`volume` integer,
	`trade_value` real,
	`source` text NOT NULL,
	`ingested_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operational_bar_generation_market_code_date_uq` ON `operational_daily_bars` (`generation_id`,`market`,`code`,`trading_date`);--> statement-breakpoint
CREATE INDEX `operational_bar_generation_date_idx` ON `operational_daily_bars` (`generation_id`,`trading_date`);--> statement-breakpoint
CREATE INDEX `operational_bar_generation_code_date_idx` ON `operational_daily_bars` (`generation_id`,`market`,`code`,`trading_date`);--> statement-breakpoint
CREATE TABLE `operational_generations` (
	`generation_id` text PRIMARY KEY NOT NULL,
	`snapshot_version` text NOT NULL,
	`source_sha256` text NOT NULL,
	`base_last_date` text NOT NULL,
	`status` text DEFAULT 'shadow' NOT NULL,
	`retention_trading_days` integer NOT NULL,
	`expected_bars` integer NOT NULL,
	`expected_quotes` integer NOT NULL,
	`expected_chunks` integer NOT NULL,
	`imported_bars` integer DEFAULT 0 NOT NULL,
	`imported_quotes` integer DEFAULT 0 NOT NULL,
	`imported_chunks` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`activated_at` text,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `operational_generation_status_idx` ON `operational_generations` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `operational_import_chunks` (
	`generation_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`sha256` text NOT NULL,
	`bars_written` integer NOT NULL,
	`quotes_written` integer NOT NULL,
	`imported_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operational_chunk_generation_index_uq` ON `operational_import_chunks` (`generation_id`,`chunk_index`);--> statement-breakpoint
CREATE TABLE `operational_ingestion_units` (
	`generation_id` text NOT NULL,
	`market` text NOT NULL,
	`trading_date` text NOT NULL,
	`status` text NOT NULL,
	`rows_fetched` integer DEFAULT 0 NOT NULL,
	`rows_stored` integer DEFAULT 0 NOT NULL,
	`source_checksum` text,
	`attempts` integer DEFAULT 1 NOT NULL,
	`last_error` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operational_unit_generation_market_date_uq` ON `operational_ingestion_units` (`generation_id`,`market`,`trading_date`);--> statement-breakpoint
CREATE INDEX `operational_unit_generation_status_idx` ON `operational_ingestion_units` (`generation_id`,`status`,`trading_date`);--> statement-breakpoint
CREATE TABLE `operational_latest_quotes` (
	`generation_id` text NOT NULL,
	`market` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`security_type` text NOT NULL,
	`trading_date` text NOT NULL,
	`open` real,
	`high` real,
	`low` real,
	`close` real,
	`change` real,
	`volume` integer,
	`trade_value` real,
	`source` text NOT NULL,
	`ingested_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operational_quote_generation_market_code_uq` ON `operational_latest_quotes` (`generation_id`,`market`,`code`);--> statement-breakpoint
CREATE INDEX `operational_quote_generation_code_name_idx` ON `operational_latest_quotes` (`generation_id`,`code`,`name`);--> statement-breakpoint
CREATE TABLE `operational_market_indices` (
	`generation_id` text NOT NULL,
	`index_code` text NOT NULL,
	`index_name` text NOT NULL,
	`trading_date` text NOT NULL,
	`close` real,
	`change` real,
	`change_percent` real,
	`source` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operational_index_generation_code_uq` ON `operational_market_indices` (`generation_id`,`index_code`);--> statement-breakpoint
CREATE TABLE `operational_securities` (
	`generation_id` text NOT NULL,
	`market` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`security_type` text NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operational_security_generation_market_code_uq` ON `operational_securities` (`generation_id`,`market`,`code`);--> statement-breakpoint
CREATE INDEX `operational_security_search_idx` ON `operational_securities` (`generation_id`,`code`,`name`);--> statement-breakpoint
CREATE TABLE `operational_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`active_generation` text,
	`retention_trading_days` integer DEFAULT 300 NOT NULL,
	`policy_version` text NOT NULL,
	`strategy_max_lookback` integer NOT NULL,
	`forecast_max_horizon` integer NOT NULL,
	`safety_buffer_days` integer NOT NULL,
	`latest_completed_date` text,
	`freshness_status` text DEFAULT 'rebuilding' NOT NULL,
	`last_incremental_at` text,
	`updated_at` text NOT NULL
);

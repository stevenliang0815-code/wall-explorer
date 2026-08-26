CREATE TABLE `daily_incremental_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`market` text NOT NULL,
	`trading_date` text NOT NULL,
	`status` text NOT NULL,
	`rows_written` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`last_error` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_incremental_market_date_uq` ON `daily_incremental_runs` (`market`,`trading_date`);--> statement-breakpoint
CREATE TABLE `historical_snapshot_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_version` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`status` text NOT NULL,
	`rows_written` integer DEFAULT 0 NOT NULL,
	`sha256` text NOT NULL,
	`imported_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `historical_snapshot_version_chunk_uq` ON `historical_snapshot_chunks` (`snapshot_version`,`chunk_index`);--> statement-breakpoint
CREATE TABLE `historical_snapshot_imports` (
	`id` integer PRIMARY KEY NOT NULL,
	`snapshot_version` text NOT NULL,
	`manifest_url` text NOT NULL,
	`cutoff_date` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expected_rows` integer NOT NULL,
	`imported_rows` integer DEFAULT 0 NOT NULL,
	`next_chunk` integer DEFAULT 0 NOT NULL,
	`total_chunks` integer NOT NULL,
	`sqlite_sha256` text NOT NULL,
	`last_error` text,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text
);

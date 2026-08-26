CREATE TABLE `model_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version` text NOT NULL,
	`horizon` integer NOT NULL,
	`train_start` text,
	`train_end` text,
	`test_start` text,
	`test_end` text,
	`sample_count` integer DEFAULT 0 NOT NULL,
	`brier_score` real,
	`calibration_error` real,
	`after_cost_return` real,
	`max_drawdown` real,
	`status` text DEFAULT 'building' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `model_runs_horizon_time_idx` ON `model_runs` (`horizon`,`created_at`);--> statement-breakpoint
CREATE TABLE `source_syncs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`endpoint` text NOT NULL,
	`status` text NOT NULL,
	`official_date` text,
	`fetched_at` text NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`checksum` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `source_sync_source_time_idx` ON `source_syncs` (`source`,`fetched_at`);--> statement-breakpoint
CREATE TABLE `stock_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`market` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`trading_date` text NOT NULL,
	`open` real,
	`high` real,
	`low` real,
	`close` real,
	`change` real,
	`volume` integer,
	`trade_value` real,
	`source` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_snapshot_market_code_date_uq` ON `stock_snapshots` (`market`,`code`,`trading_date`);--> statement-breakpoint
CREATE INDEX `stock_snapshot_code_date_idx` ON `stock_snapshots` (`code`,`trading_date`);--> statement-breakpoint
CREATE TABLE `watchlist` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_key` text NOT NULL,
	`code` text NOT NULL,
	`market` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watchlist_owner_stock_uq` ON `watchlist` (`owner_key`,`market`,`code`);
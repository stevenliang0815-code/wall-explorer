CREATE TABLE `backfill_failures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`backfill_job_id` integer NOT NULL,
	`market` text NOT NULL,
	`trading_date` text NOT NULL,
	`source` text NOT NULL,
	`error` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backfill_failure_job_market_date_uq` ON `backfill_failures` (`backfill_job_id`,`market`,`trading_date`);--> statement-breakpoint
CREATE INDEX `backfill_failure_status_idx` ON `backfill_failures` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `backfill_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version` text NOT NULL,
	`target_start` text NOT NULL,
	`target_end` text NOT NULL,
	`cursor_date` text NOT NULL,
	`cursor_market` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`processed_units` integer DEFAULT 0 NOT NULL,
	`total_units` integer NOT NULL,
	`stored_rows` integer DEFAULT 0 NOT NULL,
	`empty_units` integer DEFAULT 0 NOT NULL,
	`failed_units` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `backfill_jobs_status_time_idx` ON `backfill_jobs` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `bias_audits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`backfill_job_id` integer NOT NULL,
	`market` text NOT NULL,
	`trading_date` text NOT NULL,
	`audit_type` text NOT NULL,
	`status` text NOT NULL,
	`checked_rows` integer DEFAULT 0 NOT NULL,
	`violations` integer DEFAULT 0 NOT NULL,
	`rule` text NOT NULL,
	`checked_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bias_audit_job_market_date_type_uq` ON `bias_audits` (`backfill_job_id`,`market`,`trading_date`,`audit_type`);--> statement-breakpoint
CREATE INDEX `bias_audit_status_idx` ON `bias_audits` (`audit_type`,`status`);--> statement-breakpoint
CREATE TABLE `historical_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`market` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`trading_date` text NOT NULL,
	`security_type` text NOT NULL,
	`universe_status` text NOT NULL,
	`open` real,
	`high` real,
	`low` real,
	`close` real,
	`change` real,
	`volume` integer,
	`trade_value` real,
	`source` text NOT NULL,
	`source_scope` text NOT NULL,
	`usable_from` text NOT NULL,
	`ingested_at` text NOT NULL,
	`backfill_job_id` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `historical_observation_market_code_date_uq` ON `historical_observations` (`market`,`code`,`trading_date`);--> statement-breakpoint
CREATE INDEX `historical_observation_date_market_idx` ON `historical_observations` (`trading_date`,`market`);--> statement-breakpoint
CREATE INDEX `historical_observation_usable_idx` ON `historical_observations` (`usable_from`,`security_type`);
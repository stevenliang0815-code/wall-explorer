CREATE TABLE `backfill_batches` (
	`batch_id` text PRIMARY KEY NOT NULL,
	`backfill_job_id` integer NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`completed_units` integer DEFAULT 0 NOT NULL,
	`rows_fetched` integer DEFAULT 0 NOT NULL,
	`rows_written` integer DEFAULT 0 NOT NULL,
	`network_ms` integer DEFAULT 0 NOT NULL,
	`parse_ms` integer DEFAULT 0 NOT NULL,
	`db_write_ms` integer DEFAULT 0 NOT NULL,
	`api_retry_count` integer DEFAULT 0 NOT NULL,
	`throttled_ms` integer DEFAULT 0 NOT NULL,
	`worker_wait_ms` integer DEFAULT 0 NOT NULL,
	`feature_ms` integer DEFAULT 0 NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `backfill_batches_job_time_idx` ON `backfill_batches` (`backfill_job_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `backfill_checkpoints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`backfill_job_id` integer NOT NULL,
	`market` text NOT NULL,
	`trading_date` text NOT NULL,
	`status` text NOT NULL,
	`batch_id` text NOT NULL,
	`rows_fetched` integer DEFAULT 0 NOT NULL,
	`rows_written` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`last_error` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backfill_checkpoint_job_market_date_uq` ON `backfill_checkpoints` (`backfill_job_id`,`market`,`trading_date`);--> statement-breakpoint
CREATE INDEX `backfill_checkpoint_status_idx` ON `backfill_checkpoints` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `historical_securities` (
	`market` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`security_type` text NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `historical_security_market_code_uq` ON `historical_securities` (`market`,`code`);--> statement-breakpoint
ALTER TABLE `backfill_jobs` ADD `phase` text DEFAULT 'raw_history' NOT NULL;--> statement-breakpoint
ALTER TABLE `backfill_jobs` ADD `estimated_total_rows` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backfill_jobs` ADD `last_batch_id` text;--> statement-breakpoint
ALTER TABLE `backfill_jobs` ADD `last_batch_rows` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backfill_jobs` ADD `last_checkpoint_at` text;--> statement-breakpoint
ALTER TABLE `backfill_jobs` ADD `api_retry_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backfill_jobs` ADD `throttled_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backfill_runner` ADD `active_runtime_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backfill_runner` ADD `last_batch_rows` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backfill_runner` ADD `last_batch_duration_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backfill_runner` ADD `recent_rows_per_second` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backfill_runner` ADD `api_retry_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backfill_runner` ADD `throttled_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backfill_runner` ADD `network_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backfill_runner` ADD `parse_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backfill_runner` ADD `db_write_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backfill_runner` ADD `worker_wait_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backfill_runner` ADD `rate_limited` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `backfill_runner` ADD `checkpoint_status` text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `historical_securities` (`market`,`code`,`name`,`security_type`,`first_seen`,`last_seen`)
SELECT `market`,`code`,max(`name`),max(`security_type`),min(`trading_date`),max(`trading_date`)
FROM `historical_observations` GROUP BY `market`,`code`;--> statement-breakpoint
UPDATE `backfill_runner`
SET `active_runtime_ms` = `completed_batches` * 25000,
    `checkpoint_status` = CASE WHEN `completed_units` > 0 THEN 'saved' ELSE 'not_started' END
WHERE `active_runtime_ms` = 0;

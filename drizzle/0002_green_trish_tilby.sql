CREATE TABLE `backfill_runner` (
	`id` integer PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`last_started_at` text,
	`last_heartbeat_at` text,
	`last_finished_at` text,
	`completed_batches` integer DEFAULT 0 NOT NULL,
	`completed_units` integer DEFAULT 0 NOT NULL,
	`last_error` text
);

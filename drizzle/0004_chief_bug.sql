ALTER TABLE `backfill_runner` ADD `automation_enabled` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `backfill_runner` ADD `scheduler_interval_minutes` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `backfill_runner` ADD `scheduler_last_triggered_at` text;--> statement-breakpoint
ALTER TABLE `backfill_runner` ADD `scheduler_next_expected_at` text;--> statement-breakpoint
ALTER TABLE `backfill_runner` ADD `last_trigger_source` text DEFAULT 'manual' NOT NULL;
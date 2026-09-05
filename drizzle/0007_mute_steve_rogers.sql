ALTER TABLE `operational_generations` ADD `chunk_rows` integer DEFAULT 900 NOT NULL;--> statement-breakpoint
ALTER TABLE `operational_import_chunks` ADD `source_kind` text;--> statement-breakpoint
ALTER TABLE `operational_import_chunks` ADD `source_last_id` integer;
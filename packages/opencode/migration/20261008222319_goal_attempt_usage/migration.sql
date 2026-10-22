CREATE TABLE `session_usage` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`root_session_id` text NOT NULL,
	`ancestors` text NOT NULL,
	`time_created` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_session_usage_root_session_id_session_id_fk` FOREIGN KEY (`root_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `goal` ADD `usage_baseline` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `goal` ADD `usage_end` text;--> statement-breakpoint
ALTER TABLE `goal` ADD `last_assistant_id` text;--> statement-breakpoint
CREATE INDEX `session_usage_session_idx` ON `session_usage` (`session_id`);--> statement-breakpoint
CREATE INDEX `session_usage_root_idx` ON `session_usage` (`root_session_id`);
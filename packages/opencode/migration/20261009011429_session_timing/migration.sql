CREATE TABLE `session_timing` (
	`id` text PRIMARY KEY,
	`execution_id` text NOT NULL,
	`session_id` text NOT NULL,
	`step_id` text NOT NULL,
	`root_session_id` text NOT NULL,
	`time_created` integer NOT NULL,
	`phase` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_session_timing_root_session_id_session_id_fk` FOREIGN KEY (`root_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `session_timing_execution_id_idx` ON `session_timing` (`execution_id`);--> statement-breakpoint
CREATE INDEX `session_timing_session_id_time_created_idx` ON `session_timing` (`session_id`,`time_created`);--> statement-breakpoint
CREATE INDEX `session_timing_root_session_id_idx` ON `session_timing` (`root_session_id`);--> statement-breakpoint
CREATE INDEX `session_timing_time_created_id_idx` ON `session_timing` (`time_created`,`id`);
CREATE TABLE `metaagent` (
	`session_id` text NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`base_prompt` text DEFAULT '' NOT NULL,
	`model_provider` text,
	`model_id` text,
	`effort` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_metaagent_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `metaagent_session_idx` ON `metaagent` (`session_id`);
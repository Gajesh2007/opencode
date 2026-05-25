DROP TABLE IF EXISTS `goal`;
--> statement-breakpoint
DROP INDEX IF EXISTS `goal_session_idx`;
--> statement-breakpoint
CREATE TABLE `goal` (
	`session_id` text NOT NULL,
	`objective` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`token_budget` integer,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`cost_budget` real,
	`cost_used` real DEFAULT 0 NOT NULL,
	`blocked_turns` integer DEFAULT 0 NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_goal_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `goal_session_idx` ON `goal` (`session_id`);
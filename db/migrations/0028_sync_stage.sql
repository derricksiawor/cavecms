-- Migration 0027 — sync_stage staging area for the local→prod content push.
--
-- POST /api/cms/sync/stage validates an uploaded bundle, uploads its media
-- into the live media set (additive), and persists the resulting insert-ready,
-- media-resolved payload here keyed by a random stageId. POST /api/cms/sync/
-- cutover reads it and runs the atomic applyBundle transaction. Rows expire
-- after 1h; a sweep deletes expired rows. The payload holds content only — no
-- secrets, no raw bundle bytes.
CREATE TABLE `sync_stage` (
	`id` varchar(36) NOT NULL,
	`payload` json NOT NULL,
	`content_hash` varchar(64) NOT NULL,
	`created_by` int,
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `sync_stage_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_sync_stage_expires` ON `sync_stage` (`expires_at`);
--> statement-breakpoint
ALTER TABLE `sync_stage` ADD CONSTRAINT `sync_stage_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;

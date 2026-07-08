ALTER TABLE `pages` ADD COLUMN `edit_lock_user_id` int;--> statement-breakpoint
ALTER TABLE `pages` ADD COLUMN `edit_lock_heartbeat_at` timestamp(3) NULL;

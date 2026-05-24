ALTER TABLE `media_references` MODIFY COLUMN `field` varchar(512) NOT NULL;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `user_agent` varchar(255);--> statement-breakpoint
ALTER TABLE `audit_log` ADD `request_id` varchar(36);
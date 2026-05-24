DROP INDEX `idx_posts_deleted` ON `posts`;--> statement-breakpoint
DROP INDEX `idx_leads_created` ON `leads`;--> statement-breakpoint
CREATE INDEX `idx_audit_resource_action_created` ON `audit_log` (`resource_type`,`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_posts_deleted_updated` ON `posts` (`deleted_at`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_leads_created_id` ON `leads` (`created_at`,`id`);
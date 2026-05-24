ALTER TABLE `leads` ADD `deleted_at` timestamp(3);--> statement-breakpoint
CREATE INDEX `idx_leads_deleted` ON `leads` (`deleted_at`);
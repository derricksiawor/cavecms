CREATE TABLE `leads` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source` varchar(16) NOT NULL,
	`name` varchar(180),
	`email` varchar(180),
	`phone` varchar(40),
	`message` text,
	`project_id` int,
	`status` varchar(16) NOT NULL DEFAULT 'new',
	`notes` text,
	`brochure_token_used_at` timestamp(3),
	`ip` varchar(45),
	`user_agent` varchar(255),
	`status_changed_at` timestamp(3),
	`status_changed_by` int,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `leads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `newsletter_subscribers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`email` varchar(180) NOT NULL,
	`status` varchar(24) NOT NULL DEFAULT 'pending_confirmation',
	`unsubscribe_token` varchar(64) NOT NULL,
	`source` varchar(40),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `newsletter_subscribers_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_newsletter_email` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `pending_emails` (
	`id` int AUTO_INCREMENT NOT NULL,
	`to_email` varchar(180) NOT NULL,
	`subject` varchar(255) NOT NULL,
	`html_body` mediumtext NOT NULL,
	`text_body` mediumtext NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`next_retry_at` timestamp(3) NOT NULL DEFAULT (now()),
	`resolved_at` timestamp(3),
	`last_error` text,
	`claim_until` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `pending_emails_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `leads` ADD CONSTRAINT `leads_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `leads` ADD CONSTRAINT `leads_status_changed_by_users_id_fk` FOREIGN KEY (`status_changed_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_leads_status_created` ON `leads` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_leads_source` ON `leads` (`source`);--> statement-breakpoint
CREATE INDEX `idx_leads_created` ON `leads` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_leads_source_status_created` ON `leads` (`source`,`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_pending_emails_due` ON `pending_emails` (`resolved_at`,`next_retry_at`);
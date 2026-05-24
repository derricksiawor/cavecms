CREATE TABLE `content_blocks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`page_id` int NOT NULL,
	`block_key` varchar(50),
	`block_type` varchar(50) NOT NULL,
	`position` int NOT NULL,
	`data` json NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	`deleted_at` timestamp(3),
	`updated_by` int,
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `content_blocks_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_blocks_page_key` UNIQUE(`page_id`,`block_key`)
);
--> statement-breakpoint
CREATE TABLE `pages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`slug` varchar(50) NOT NULL,
	`seo_title` varchar(180),
	`seo_description` varchar(320),
	`og_image_id` int,
	`version` int NOT NULL DEFAULT 0,
	`updated_by` int,
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `pages_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_pages_slug` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `media` (
	`id` int AUTO_INCREMENT NOT NULL,
	`filename_uuid` varchar(40) NOT NULL,
	`original_name` varchar(255),
	`mime_type` varchar(80) NOT NULL,
	`alt_text` varchar(320) NOT NULL,
	`width` int,
	`height` int,
	`byte_size` int NOT NULL,
	`variants` json,
	`uploaded_by` int,
	`deleted_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `media_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_media_filename` UNIQUE(`filename_uuid`)
);
--> statement-breakpoint
CREATE TABLE `media_references` (
	`media_id` int NOT NULL,
	`referent_type` varchar(24) NOT NULL,
	`referent_id` int NOT NULL,
	`field` varchar(200) NOT NULL,
	CONSTRAINT `media_references_media_id_referent_type_referent_id_field_pk` PRIMARY KEY(`media_id`,`referent_type`,`referent_id`,`field`)
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`user_id` int,
	`action` varchar(40) NOT NULL,
	`resource_type` varchar(40) NOT NULL,
	`resource_id` varchar(60),
	`diff` json,
	`ip` varchar(45),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `audit_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notification_failures` (
	`id` int AUTO_INCREMENT NOT NULL,
	`kind` varchar(32) NOT NULL,
	`ref_table` varchar(40),
	`ref_id` int,
	`payload` json,
	`attempts` int NOT NULL DEFAULT 0,
	`last_error` text,
	`next_retry_at` timestamp(3),
	`resolved_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `notification_failures_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `schema_fingerprint` (
	`id` int NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`applied_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `schema_fingerprint_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `content_blocks` ADD CONSTRAINT `content_blocks_updated_by_users_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `pages` ADD CONSTRAINT `pages_updated_by_users_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media` ADD CONSTRAINT `media_uploaded_by_users_id_fk` FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_references` ADD CONSTRAINT `media_references_media_id_media_id_fk` FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `audit_log` ADD CONSTRAINT `audit_log_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_blocks_page` ON `content_blocks` (`page_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_blocks_deleted` ON `content_blocks` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `idx_media_deleted` ON `media` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_created` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_user_created` ON `audit_log` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_resource` ON `audit_log` (`resource_type`,`resource_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_action` ON `audit_log` (`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_notif_kind_pending` ON `notification_failures` (`kind`,`resolved_at`,`next_retry_at`);
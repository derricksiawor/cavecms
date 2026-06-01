CREATE TABLE IF NOT EXISTS `redirects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source` varchar(512) NOT NULL,
	`match_type` varchar(16) NOT NULL,
	`action` varchar(16) NOT NULL DEFAULT 'redirect',
	`target` varchar(2048) NULL DEFAULT NULL,
	`status_code` smallint NULL DEFAULT NULL,
	`query_handling` varchar(16) NOT NULL DEFAULT 'passthrough',
	`case_insensitive` boolean NOT NULL DEFAULT true,
	`enabled` boolean NOT NULL DEFAULT true,
	`position` int NOT NULL DEFAULT 0,
	`hit_count` int NOT NULL DEFAULT 0,
	`last_hit_at` datetime(3) NULL DEFAULT NULL,
	`notes` varchar(255) NULL DEFAULT NULL,
	`created_by` int NULL DEFAULT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `redirects_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_redirects_source_type` UNIQUE(`source`,`match_type`),
	KEY `idx_redirects_enabled_pos` (`enabled`,`position`),
	CONSTRAINT `redirects_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `not_found_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`path` varchar(512) NOT NULL,
	`hits` int NOT NULL DEFAULT 1,
	`last_seen_at` timestamp(3) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`referrer` varchar(512) NULL DEFAULT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `not_found_log_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_not_found_path` UNIQUE(`path`),
	KEY `idx_not_found_last_seen` (`last_seen_at`)
);

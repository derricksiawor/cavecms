CREATE TABLE IF NOT EXISTS `api_tokens` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(120) NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`token_prefix` varchar(16) NOT NULL,
	`role` varchar(16) NOT NULL,
	`created_by` int NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`last_used_at` datetime(3) NULL DEFAULT NULL,
	`expires_at` datetime(3) NULL DEFAULT NULL,
	`revoked_at` datetime(3) NULL DEFAULT NULL,
	CONSTRAINT `api_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_api_tokens_hash` UNIQUE(`token_hash`),
	KEY `idx_api_tokens_created_by` (`created_by`),
	CONSTRAINT `api_tokens_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE CASCADE
);

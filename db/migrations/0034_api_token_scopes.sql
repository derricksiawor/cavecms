ALTER TABLE `api_tokens`
	ADD COLUMN `scopes` json NULL DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE `audit_log`
	ADD COLUMN `token_id` int NULL DEFAULT NULL,
	ADD KEY `idx_audit_log_token` (`token_id`),
	ADD CONSTRAINT `audit_log_token_id_api_tokens_id_fk`
		FOREIGN KEY (`token_id`) REFERENCES `api_tokens`(`id`) ON DELETE SET NULL;

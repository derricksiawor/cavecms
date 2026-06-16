-- Admin-issued, single-use password-reset tokens (0.4.x).
-- Only the SHA-256 hash of the raw token is stored; the raw token
-- lives solely in the copied link / emailed URL. Single-use via
-- consumed_at; 60-minute expiry set at issue time. ON DELETE CASCADE
-- on user_id removes a user's outstanding links when they are removed.
CREATE TABLE IF NOT EXISTS `password_reset_tokens` (
  `id` int AUTO_INCREMENT NOT NULL,
  `user_id` int NOT NULL,
  `token_hash` varchar(64) NOT NULL,
  `expires_at` timestamp(3) NOT NULL,
  `consumed_at` timestamp(3) NULL,
  `created_by` int NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  CONSTRAINT `password_reset_tokens_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_prt_token_hash` ON `password_reset_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `idx_prt_user` ON `password_reset_tokens` (`user_id`);
--> statement-breakpoint
ALTER TABLE `password_reset_tokens` ADD CONSTRAINT `fk_prt_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE `password_reset_tokens` ADD CONSTRAINT `fk_prt_created_by` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION;

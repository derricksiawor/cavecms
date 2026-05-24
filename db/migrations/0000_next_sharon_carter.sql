CREATE TABLE `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`email` varchar(180) NOT NULL,
	`password_hash` varchar(400) NOT NULL,
	`role` varchar(16) NOT NULL,
	`name` varchar(180),
	`active` boolean NOT NULL DEFAULT true,
	`must_rotate_password` boolean NOT NULL DEFAULT false,
	`tokens_valid_after` timestamp(3) NOT NULL DEFAULT (now()),
	`password_changed_at` timestamp(3) NOT NULL DEFAULT (now()),
	`last_login_at` timestamp(3),
	`locked_until` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_users_email` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `failed_logins_by_email` (
	`email` varchar(180) NOT NULL,
	`count` int NOT NULL DEFAULT 0,
	`last_failure_at` timestamp(3) NOT NULL DEFAULT (now()),
	`locked_until` timestamp(3),
	CONSTRAINT `failed_logins_by_email_email` PRIMARY KEY(`email`)
);
--> statement-breakpoint
CREATE TABLE `failed_logins_by_ip` (
	`ip` varchar(45) NOT NULL,
	`count` int NOT NULL DEFAULT 0,
	`last_failure_at` timestamp(3) NOT NULL DEFAULT (now()),
	`locked_until` timestamp(3),
	CONSTRAINT `failed_logins_by_ip_ip` PRIMARY KEY(`ip`)
);
--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`email` varchar(180),
	`ip` varchar(45),
	`user_agent` varchar(255),
	`success` boolean NOT NULL,
	`failure_reason` varchar(60),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `login_attempts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_known_ips` (
	`user_id` int NOT NULL,
	`ip` varchar(45) NOT NULL,
	`last_success_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `user_known_ips_user_id_ip_pk` PRIMARY KEY(`user_id`,`ip`)
);
--> statement-breakpoint
ALTER TABLE `user_known_ips` ADD CONSTRAINT `user_known_ips_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_attempts_email_created` ON `login_attempts` (`success`,`email`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_attempts_ip_created` ON `login_attempts` (`success`,`ip`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_attempts_created` ON `login_attempts` (`created_at`);
CREATE TABLE `posts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`slug` varchar(140) NOT NULL,
	`title` varchar(220) NOT NULL,
	`excerpt` varchar(320),
	`body_md` mediumtext NOT NULL,
	`hero_image_id` int,
	`published` boolean NOT NULL DEFAULT false,
	`published_at` timestamp(3),
	`author_id` int,
	`seo_title` varchar(180),
	`seo_description` varchar(320),
	`og_image_id` int,
	`version` int NOT NULL DEFAULT 0,
	`deleted_at` timestamp(3),
	`updated_by` int,
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `posts_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_posts_slug` UNIQUE(`slug`)
);
--> statement-breakpoint
ALTER TABLE `posts` ADD CONSTRAINT `posts_author_id_users_id_fk` FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `posts` ADD CONSTRAINT `posts_updated_by_users_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_posts_published` ON `posts` (`published`,`published_at`);--> statement-breakpoint
CREATE INDEX `idx_posts_deleted` ON `posts` (`deleted_at`);
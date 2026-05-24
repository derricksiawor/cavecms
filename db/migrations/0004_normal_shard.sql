CREATE TABLE `project_sections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`project_id` int NOT NULL,
	`section_key` varchar(32) NOT NULL,
	`position` int NOT NULL,
	`data` json NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	`updated_by` int,
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `project_sections_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_psecs_project_key` UNIQUE(`project_id`,`section_key`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`slug` varchar(120) NOT NULL,
	`name` varchar(120) NOT NULL,
	`tagline` varchar(220),
	`status` varchar(24) NOT NULL,
	`location` varchar(180),
	`hero_image_id` int,
	`brochure_pdf_id` int,
	`featured_order` int,
	`published` boolean NOT NULL DEFAULT false,
	`published_at` timestamp(3),
	`seo_title` varchar(180),
	`seo_description` varchar(320),
	`og_image_id` int,
	`preview_epoch` int NOT NULL DEFAULT 0,
	`version` int NOT NULL DEFAULT 0,
	`deleted_at` timestamp(3),
	`updated_by` int,
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `projects_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_projects_slug` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `slug_redirects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`resource_type` varchar(16) NOT NULL,
	`old_slug` varchar(140) NOT NULL,
	`new_slug` varchar(140) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `slug_redirects_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_redirects_type_old` UNIQUE(`resource_type`,`old_slug`)
);
--> statement-breakpoint
ALTER TABLE `project_sections` ADD CONSTRAINT `project_sections_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `project_sections` ADD CONSTRAINT `project_sections_updated_by_users_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_updated_by_users_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_psecs_project_position` ON `project_sections` (`project_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_projects_published` ON `projects` (`published`,`featured_order`);--> statement-breakpoint
CREATE INDEX `idx_projects_deleted` ON `projects` (`deleted_at`);
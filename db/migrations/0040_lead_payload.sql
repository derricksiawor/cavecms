ALTER TABLE `leads` ADD COLUMN IF NOT EXISTS `payload` json AFTER `message`;

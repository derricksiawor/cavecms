-- Migration 0028 — indexes for the content-sync hot paths.
--
-- idx_media_dedup: the stage step looks media up by identity (byte_size first —
-- most selective for an `=` probe — then original_name) to dedup re-pushed
-- files. Without this it is one full media scan per bundle entry.
CREATE INDEX `idx_media_dedup` ON `media` (`byte_size`, `original_name`);
--> statement-breakpoint
-- idx_mref_referent: the cutover bulk-deletes + re-derives media_references by
-- (referent_type, referent_id). The composite PK leads with media_id, so these
-- reverse lookups can't use it; this secondary index makes them range scans.
CREATE INDEX `idx_mref_referent` ON `media_references` (`referent_type`, `referent_id`);

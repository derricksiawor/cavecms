-- Content-addressing discriminator for the sync media dedup. sha256 (hex) of
-- the ORIGINAL uploaded bytes, so two different files that happen to share
-- (original_name, byte_size, width, height, mime_type) never collapse to one
-- media row / bundle key. NULL for rows uploaded before this column existed —
-- those keep the prior metadata-tuple behaviour. Populated going forward by the
-- media upload route and by the sync media-provision step.
ALTER TABLE media ADD COLUMN IF NOT EXISTS content_hash VARCHAR(64) NULL AFTER byte_size;

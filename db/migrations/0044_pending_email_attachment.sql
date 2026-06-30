-- Optional PDF attachment carried by a queued email (0.4.x).
-- The lx_form deliver_file `attach` mode emails the gated file as a real
-- attachment instead of a signed link. The email queue persists rows and
-- sends later, so the attachment travels as a reference (the media row id),
-- resolved + streamed from disk at send time — never the bytes inline.
-- NULL = an ordinary email with no attachment (the default for every existing
-- and future non-attach send), so the column is fully backward-compatible.
ALTER TABLE `pending_emails` ADD COLUMN `attachment_media_id` int NULL DEFAULT NULL;

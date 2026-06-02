-- Migration 0029 — store the drift baseline on the staged push.
--
-- The bundle's pull-time baseline content hash is recorded at stage time so the
-- cutover reads it from the immutable staged record rather than trusting a
-- per-request body field (which a direct API caller could null out to skip the
-- drift gate). NULL means "no baseline" (e.g. a from-scratch local bundle) —
-- the cutover then requires an explicit force to overwrite.
ALTER TABLE `sync_stage` ADD `baseline_content_hash` varchar(64);

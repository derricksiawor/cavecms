-- 0041_retire_legacy_form_blocks.sql
--
-- Project + Contact lead-forms → lx_form re-architecture (spec
-- docs/superpowers/specs/2026-06-07-project-contact-forms-rearchitecture.md).
--
-- Converts every stored `contact_form` / `lx_inquiry_form` /
-- `lx_brochure_form` content_blocks row (live, trashed, and the
-- draft_data overlay) into an equivalent general `lx_form` row, so the
-- three bespoke block types can retire from the registry. Project
-- binding becomes DATA on the block:
--   - a hidden `project_id` field (defaultValue = the owning project's
--     id, snapshotted now) — the lead route re-reads it server-side
--   - a `deliver_file` action snapshotting the project's CURRENT
--     brochure_pdf_id (re-point is a drawer edit if the PDF changes)
--
-- The converted shapes mirror lib/cms/formPresets.ts — keep in lockstep.
--
-- Safety:
--   - Every affected row (the form widgets AND their host sections,
--     whose meta this migration also touches) is copied into
--     `content_blocks_legacy_forms_0041` BEFORE any write. Restoring
--     that table's rows back over content_blocks reverses everything.
--   - Idempotent: each backup INSERT is keyed on the row id (INSERT
--     IGNORE), and every UPDATE keys on the legacy block_type — after
--     conversion the type is `lx_form`, so a re-run matches nothing.
--   - Statements are individually atomic; an abort mid-file leaves
--     earlier statements applied, and a re-run completes the rest.
--
-- Equivalence notes:
--   - The legacy in-page anchors survive: the first inquiry/brochure
--     form per page gets meta.htmlId = 'inquiry-form' / 'brochure'
--     (guarded against the per-page html_id_live unique index), so the
--     hero "Schedule a tour" / "Download brochure" hash CTAs keep
--     working on migrated pages.
--   - The legacy form blocks painted their own full-bleed band, so the
--     host section was seeded padding:'none'. The general lx_form does
--     not, so those sections flip to padding:'xl', and a legacy
--     `background` override on the block data is promoted to the host
--     section's background.
--   - An inquiry/brochure block whose page no longer maps to a live
--     project (or whose project has no brochure PDF) rendered NOTHING
--     under the legacy renderers. Those rows convert to an unbound
--     lx_form AND are soft-deleted (deleted_at) so the public page is
--     unchanged; the original is in the backup table.

CREATE TABLE IF NOT EXISTS content_blocks_legacy_forms_0041 (
  id INT NOT NULL PRIMARY KEY,
  page_id INT NOT NULL,
  parent_id INT NULL,
  kind VARCHAR(16) NOT NULL,
  block_key VARCHAR(50) NULL,
  block_type VARCHAR(50) NOT NULL,
  position INT NOT NULL,
  data JSON NULL,
  meta JSON NULL,
  version INT NOT NULL,
  draft_data JSON NULL,
  draft_meta JSON NULL,
  draft_position INT NULL,
  draft_parent_id INT NULL,
  draft_state VARCHAR(16) NOT NULL,
  deleted_at TIMESTAMP(3) NULL,
  updated_by INT NULL,
  updated_at TIMESTAMP(3) NULL,
  backed_up_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);
--> statement-breakpoint

-- Backup: the legacy form widget rows themselves.
INSERT IGNORE INTO content_blocks_legacy_forms_0041
  (id, page_id, parent_id, kind, block_key, block_type, position, data, meta,
   version, draft_data, draft_meta, draft_position, draft_parent_id,
   draft_state, deleted_at, updated_by, updated_at)
SELECT cb.id, cb.page_id, cb.parent_id, cb.kind, cb.block_key, cb.block_type,
       cb.position, cb.data, cb.meta, cb.version, cb.draft_data, cb.draft_meta,
       cb.draft_position, cb.draft_parent_id, cb.draft_state, cb.deleted_at,
       cb.updated_by, cb.updated_at
FROM content_blocks cb
WHERE cb.block_type IN ('contact_form', 'lx_inquiry_form', 'lx_brochure_form');
--> statement-breakpoint

-- Backup: the host SECTION rows of the project form widgets (their meta
-- — padding/background — is rewritten below).
INSERT IGNORE INTO content_blocks_legacy_forms_0041
  (id, page_id, parent_id, kind, block_key, block_type, position, data, meta,
   version, draft_data, draft_meta, draft_position, draft_parent_id,
   draft_state, deleted_at, updated_by, updated_at)
SELECT sec.id, sec.page_id, sec.parent_id, sec.kind, sec.block_key,
       sec.block_type, sec.position, sec.data, sec.meta, sec.version,
       sec.draft_data, sec.draft_meta, sec.draft_position, sec.draft_parent_id,
       sec.draft_state, sec.deleted_at, sec.updated_by, sec.updated_at
FROM content_blocks sec
JOIN content_blocks col ON col.parent_id = sec.id AND col.kind = 'column'
JOIN content_blocks w   ON w.parent_id = col.id AND w.kind = 'widget'
WHERE sec.kind = 'section'
  AND w.block_type IN ('lx_inquiry_form', 'lx_brochure_form');
--> statement-breakpoint

-- Anchor preservation: the FIRST live inquiry form per page gets
-- meta.htmlId = 'inquiry-form' (the hero/sticky-header CTA hash target),
-- unless some other live block on that page already owns the id (the
-- (page_id, html_id_live) unique index would reject it).
UPDATE content_blocks cb
JOIN (
  SELECT MIN(id) AS keep_id
  FROM content_blocks
  WHERE block_type = 'lx_inquiry_form' AND deleted_at IS NULL
  GROUP BY page_id
) pick ON pick.keep_id = cb.id
LEFT JOIN (
  SELECT DISTINCT page_id AS pid FROM content_blocks
  WHERE html_id_live = 'inquiry-form'
) taken ON taken.pid = cb.page_id
SET cb.meta = JSON_SET(
  CASE WHEN cb.meta IS NULL OR NOT JSON_VALID(cb.meta) THEN '{}' ELSE cb.meta END,
  '$.htmlId', 'inquiry-form'
)
WHERE taken.pid IS NULL;
--> statement-breakpoint

UPDATE content_blocks cb
JOIN (
  SELECT MIN(id) AS keep_id
  FROM content_blocks
  WHERE block_type = 'lx_brochure_form' AND deleted_at IS NULL
  GROUP BY page_id
) pick ON pick.keep_id = cb.id
LEFT JOIN (
  SELECT DISTINCT page_id AS pid FROM content_blocks
  WHERE html_id_live = 'brochure'
) taken ON taken.pid = cb.page_id
SET cb.meta = JSON_SET(
  CASE WHEN cb.meta IS NULL OR NOT JSON_VALID(cb.meta) THEN '{}' ELSE cb.meta END,
  '$.htmlId', 'brochure'
)
WHERE taken.pid IS NULL;
--> statement-breakpoint

-- Host-section band restore (1/2): the legacy form blocks painted their
-- own py-20 band so their seeded host sections carry padding:'none';
-- the general lx_form relies on section padding. Flip exactly those.
UPDATE content_blocks sec
JOIN content_blocks col ON col.parent_id = sec.id AND col.kind = 'column'
JOIN content_blocks w   ON w.parent_id = col.id AND w.kind = 'widget'
SET sec.meta = JSON_SET(
  CASE WHEN sec.meta IS NULL OR NOT JSON_VALID(sec.meta) THEN '{}' ELSE sec.meta END,
  '$.padding', 'xl'
)
WHERE sec.kind = 'section'
  AND w.block_type IN ('lx_inquiry_form', 'lx_brochure_form')
  AND JSON_UNQUOTE(JSON_EXTRACT(sec.meta, '$.padding')) = 'none';
--> statement-breakpoint

-- Host-section band restore (2/2): a legacy `background` override on
-- the block data drove the WHOLE band's tone — promote it to the host
-- section's background so a dark inquiry band stays dark.
UPDATE content_blocks sec
JOIN content_blocks col ON col.parent_id = sec.id AND col.kind = 'column'
JOIN content_blocks w   ON w.parent_id = col.id AND w.kind = 'widget'
SET sec.meta = JSON_SET(
  CASE WHEN sec.meta IS NULL OR NOT JSON_VALID(sec.meta) THEN '{}' ELSE sec.meta END,
  '$.background', JSON_UNQUOTE(JSON_EXTRACT(w.data, '$.background'))
)
WHERE sec.kind = 'section'
  AND w.block_type IN ('lx_inquiry_form', 'lx_brochure_form')
  AND JSON_TYPE(JSON_EXTRACT(w.data, '$.background')) = 'STRING';
--> statement-breakpoint

-- contact_form → lx_form (Contact preset fields; heading/intro/labels/
-- success copy carried over; per-instance crmDestinations preserved —
-- the lx_form schema reuses the exact same shape). block_key is cleared:
-- the fixed-slot reservation retires with the block type.
UPDATE content_blocks cb
SET
  cb.data = JSON_MERGE_PATCH(
    JSON_OBJECT(
      'heading', LEFT(COALESCE(NULLIF(TRIM(CASE WHEN JSON_TYPE(JSON_EXTRACT(cb.data, '$.heading')) = 'STRING' THEN JSON_UNQUOTE(JSON_EXTRACT(cb.data, '$.heading')) END), ''), 'Send us a note.'), 220),
      'fields', JSON_ARRAY(
        JSON_OBJECT('name', 'name', 'label', 'Name', 'type', 'text', 'required', TRUE, 'role', 'name', 'width', 'half'),
        JSON_OBJECT('name', 'email', 'label', 'Email', 'type', 'email', 'required', TRUE, 'role', 'email', 'width', 'half'),
        JSON_OBJECT('name', 'phone', 'label', 'Phone', 'type', 'tel', 'required', TRUE, 'role', 'phone'),
        JSON_OBJECT('name', 'message', 'label', 'Message', 'type', 'textarea', 'required', TRUE)
      ),
      'submitLabel', LEFT(COALESCE(NULLIF(TRIM(CASE WHEN JSON_TYPE(JSON_EXTRACT(cb.data, '$.submit_label')) = 'STRING' THEN JSON_UNQUOTE(JSON_EXTRACT(cb.data, '$.submit_label')) END), ''), 'Send message'), 80),
      'actions', JSON_ARRAY()
    ),
    CASE WHEN JSON_TYPE(JSON_EXTRACT(cb.data, '$.intro')) = 'STRING' AND TRIM(JSON_UNQUOTE(JSON_EXTRACT(cb.data, '$.intro'))) <> ''
         THEN JSON_OBJECT('intro', LEFT(JSON_UNQUOTE(JSON_EXTRACT(cb.data, '$.intro')), 800)) ELSE '{}' END,
    CASE WHEN JSON_TYPE(JSON_EXTRACT(cb.data, '$.success_headline')) = 'STRING' AND TRIM(JSON_UNQUOTE(JSON_EXTRACT(cb.data, '$.success_headline'))) <> ''
         THEN JSON_OBJECT('successHeadline', LEFT(JSON_UNQUOTE(JSON_EXTRACT(cb.data, '$.success_headline')), 220)) ELSE '{}' END,
    CASE WHEN JSON_TYPE(JSON_EXTRACT(cb.data, '$.success_body')) = 'STRING' AND TRIM(JSON_UNQUOTE(JSON_EXTRACT(cb.data, '$.success_body'))) <> ''
         THEN JSON_OBJECT('successBody', LEFT(JSON_UNQUOTE(JSON_EXTRACT(cb.data, '$.success_body')), 800)) ELSE '{}' END,
    CASE WHEN JSON_TYPE(JSON_EXTRACT(cb.data, '$.crmDestinations')) = 'ARRAY'
         THEN CONCAT('{"crmDestinations":', JSON_EXTRACT(cb.data, '$.crmDestinations'), '}') ELSE '{}' END
  ),
  cb.draft_data = CASE WHEN cb.draft_data IS NOT NULL AND JSON_VALID(cb.draft_data) THEN
    JSON_MERGE_PATCH(
      JSON_OBJECT(
        'heading', LEFT(COALESCE(NULLIF(TRIM(CASE WHEN JSON_TYPE(JSON_EXTRACT(cb.draft_data, '$.heading')) = 'STRING' THEN JSON_UNQUOTE(JSON_EXTRACT(cb.draft_data, '$.heading')) END), ''), 'Send us a note.'), 220),
        'fields', JSON_ARRAY(
          JSON_OBJECT('name', 'name', 'label', 'Name', 'type', 'text', 'required', TRUE, 'role', 'name', 'width', 'half'),
          JSON_OBJECT('name', 'email', 'label', 'Email', 'type', 'email', 'required', TRUE, 'role', 'email', 'width', 'half'),
          JSON_OBJECT('name', 'phone', 'label', 'Phone', 'type', 'tel', 'required', TRUE, 'role', 'phone'),
          JSON_OBJECT('name', 'message', 'label', 'Message', 'type', 'textarea', 'required', TRUE)
        ),
        'submitLabel', LEFT(COALESCE(NULLIF(TRIM(CASE WHEN JSON_TYPE(JSON_EXTRACT(cb.draft_data, '$.submit_label')) = 'STRING' THEN JSON_UNQUOTE(JSON_EXTRACT(cb.draft_data, '$.submit_label')) END), ''), 'Send message'), 80),
        'actions', JSON_ARRAY()
      ),
      CASE WHEN JSON_TYPE(JSON_EXTRACT(cb.draft_data, '$.intro')) = 'STRING' AND TRIM(JSON_UNQUOTE(JSON_EXTRACT(cb.draft_data, '$.intro'))) <> ''
           THEN JSON_OBJECT('intro', LEFT(JSON_UNQUOTE(JSON_EXTRACT(cb.draft_data, '$.intro')), 800)) ELSE '{}' END,
      CASE WHEN JSON_TYPE(JSON_EXTRACT(cb.draft_data, '$.success_headline')) = 'STRING' AND TRIM(JSON_UNQUOTE(JSON_EXTRACT(cb.draft_data, '$.success_headline'))) <> ''
           THEN JSON_OBJECT('successHeadline', LEFT(JSON_UNQUOTE(JSON_EXTRACT(cb.draft_data, '$.success_headline')), 220)) ELSE '{}' END,
      CASE WHEN JSON_TYPE(JSON_EXTRACT(cb.draft_data, '$.success_body')) = 'STRING' AND TRIM(JSON_UNQUOTE(JSON_EXTRACT(cb.draft_data, '$.success_body'))) <> ''
           THEN JSON_OBJECT('successBody', LEFT(JSON_UNQUOTE(JSON_EXTRACT(cb.draft_data, '$.success_body')), 800)) ELSE '{}' END,
      CASE WHEN JSON_TYPE(JSON_EXTRACT(cb.draft_data, '$.crmDestinations')) = 'ARRAY'
           THEN CONCAT('{"crmDestinations":', JSON_EXTRACT(cb.draft_data, '$.crmDestinations'), '}') ELSE '{}' END
    )
  ELSE cb.draft_data END,
  cb.block_key = NULL,
  cb.block_type = 'lx_form'
WHERE cb.block_type = 'contact_form';
--> statement-breakpoint

-- lx_inquiry_form (page maps to a live project) → lx_form with the
-- project-inquiry preset fields + the hidden project_id snapshot.
-- Legacy heading carries over (default: "Reach out about <project>");
-- legacy body_richtext becomes the plain-text intro (tags stripped).
UPDATE content_blocks cb
JOIN pages pg ON pg.id = cb.page_id
JOIN projects p ON p.slug = pg.slug AND p.deleted_at IS NULL
SET
  cb.data = JSON_MERGE_PATCH(
    JSON_OBJECT(
      'heading', LEFT(COALESCE(NULLIF(TRIM(CASE WHEN JSON_TYPE(JSON_EXTRACT(cb.data, '$.heading')) = 'STRING' THEN JSON_UNQUOTE(JSON_EXTRACT(cb.data, '$.heading')) END), ''), CONCAT('Reach out about ', p.name)), 220),
      'intro', LEFT(COALESCE(NULLIF(TRIM(CASE WHEN JSON_TYPE(JSON_EXTRACT(cb.data, '$.body_richtext')) = 'STRING' THEN REGEXP_REPLACE(JSON_UNQUOTE(JSON_EXTRACT(cb.data, '$.body_richtext')), '<[^>]*>', ' ') END), ''), 'Share a few details and a member of our sales team will be in touch — usually within a working day — to arrange a private viewing or answer your questions.'), 800),
      'fields', JSON_ARRAY(
        JSON_OBJECT('name', 'name', 'label', 'Name', 'type', 'text', 'required', TRUE, 'role', 'name', 'width', 'half'),
        JSON_OBJECT('name', 'email', 'label', 'Email', 'type', 'email', 'required', TRUE, 'role', 'email', 'width', 'half'),
        JSON_OBJECT('name', 'phone', 'label', 'Phone (optional)', 'type', 'tel', 'role', 'phone'),
        JSON_OBJECT('name', 'tour_date', 'label', 'Preferred tour date', 'type', 'date', 'width', 'half'),
        JSON_OBJECT('name', 'tour_time', 'label', 'Preferred time', 'type', 'time', 'width', 'half'),
        JSON_OBJECT('name', 'message', 'label', 'Message (optional)', 'type', 'textarea'),
        JSON_OBJECT('name', 'project_id', 'label', 'Project', 'type', 'hidden', 'defaultValue', CAST(p.id AS CHAR))
      ),
      'submitLabel', 'Send inquiry',
      'successHeadline', LEFT(CONCAT('Thanks — we''ve received your inquiry about ', p.name, '.'), 220),
      'successBody', 'A member of our sales team will reach out soon.',
      'actions', JSON_ARRAY()
    ),
    '{}'
  ),
  cb.draft_data = CASE WHEN cb.draft_data IS NOT NULL AND JSON_VALID(cb.draft_data) THEN
    JSON_MERGE_PATCH(
      JSON_OBJECT(
        'heading', LEFT(COALESCE(NULLIF(TRIM(CASE WHEN JSON_TYPE(JSON_EXTRACT(cb.draft_data, '$.heading')) = 'STRING' THEN JSON_UNQUOTE(JSON_EXTRACT(cb.draft_data, '$.heading')) END), ''), CONCAT('Reach out about ', p.name)), 220),
        'intro', LEFT(COALESCE(NULLIF(TRIM(CASE WHEN JSON_TYPE(JSON_EXTRACT(cb.draft_data, '$.body_richtext')) = 'STRING' THEN REGEXP_REPLACE(JSON_UNQUOTE(JSON_EXTRACT(cb.draft_data, '$.body_richtext')), '<[^>]*>', ' ') END), ''), 'Share a few details and a member of our sales team will be in touch — usually within a working day — to arrange a private viewing or answer your questions.'), 800),
        'fields', JSON_ARRAY(
          JSON_OBJECT('name', 'name', 'label', 'Name', 'type', 'text', 'required', TRUE, 'role', 'name', 'width', 'half'),
          JSON_OBJECT('name', 'email', 'label', 'Email', 'type', 'email', 'required', TRUE, 'role', 'email', 'width', 'half'),
          JSON_OBJECT('name', 'phone', 'label', 'Phone (optional)', 'type', 'tel', 'role', 'phone'),
          JSON_OBJECT('name', 'tour_date', 'label', 'Preferred tour date', 'type', 'date', 'width', 'half'),
          JSON_OBJECT('name', 'tour_time', 'label', 'Preferred time', 'type', 'time', 'width', 'half'),
          JSON_OBJECT('name', 'message', 'label', 'Message (optional)', 'type', 'textarea'),
          JSON_OBJECT('name', 'project_id', 'label', 'Project', 'type', 'hidden', 'defaultValue', CAST(p.id AS CHAR))
        ),
        'submitLabel', 'Send inquiry',
        'successHeadline', LEFT(CONCAT('Thanks — we''ve received your inquiry about ', p.name, '.'), 220),
        'successBody', 'A member of our sales team will reach out soon.',
        'actions', JSON_ARRAY()
      ),
      '{}'
    )
  ELSE cb.draft_data END,
  cb.block_type = 'lx_form'
WHERE cb.block_type = 'lx_inquiry_form';
--> statement-breakpoint

-- Remaining lx_inquiry_form rows = pages with NO live project (the
-- legacy renderer rendered nothing for them). Convert to an unbound
-- lx_form and soft-delete so the public page stays byte-identical;
-- the original row is in the backup table.
UPDATE content_blocks cb
SET
  cb.data = JSON_OBJECT(
    'heading', LEFT(COALESCE(NULLIF(TRIM(CASE WHEN JSON_TYPE(JSON_EXTRACT(cb.data, '$.heading')) = 'STRING' THEN JSON_UNQUOTE(JSON_EXTRACT(cb.data, '$.heading')) END), ''), 'Get in touch'), 220),
    'fields', JSON_ARRAY(
      JSON_OBJECT('name', 'name', 'label', 'Name', 'type', 'text', 'required', TRUE, 'role', 'name', 'width', 'half'),
      JSON_OBJECT('name', 'email', 'label', 'Email', 'type', 'email', 'required', TRUE, 'role', 'email', 'width', 'half'),
      JSON_OBJECT('name', 'phone', 'label', 'Phone (optional)', 'type', 'tel', 'role', 'phone'),
      JSON_OBJECT('name', 'message', 'label', 'Message (optional)', 'type', 'textarea')
    ),
    'submitLabel', 'Send inquiry',
    'actions', JSON_ARRAY()
  ),
  cb.draft_data = NULL,
  cb.block_type = 'lx_form',
  cb.deleted_at = COALESCE(cb.deleted_at, NOW(3))
WHERE cb.block_type = 'lx_inquiry_form';
--> statement-breakpoint

-- lx_brochure_form (live project WITH a brochure PDF) → lx_form with
-- the gated-download preset: a deliver_file action snapshotting the
-- project's brochure media, plus the hidden project_id field. Legacy
-- gate_message_richtext becomes the plain-text intro.
UPDATE content_blocks cb
JOIN pages pg ON pg.id = cb.page_id
JOIN projects p ON p.slug = pg.slug AND p.deleted_at IS NULL AND p.brochure_pdf_id IS NOT NULL
SET
  cb.data = JSON_OBJECT(
    'heading', 'The complete dossier, sent to your inbox',
    'intro', LEFT(COALESCE(NULLIF(TRIM(CASE WHEN JSON_TYPE(JSON_EXTRACT(cb.data, '$.gate_message_richtext')) = 'STRING' THEN REGEXP_REPLACE(JSON_UNQUOTE(JSON_EXTRACT(cb.data, '$.gate_message_richtext')), '<[^>]*>', ' ') END), ''), 'We''ll email you a download link with the full brochure, including pricing, plans, and the neighbourhood guide. The link works for 7 days.'), 800),
    'fields', JSON_ARRAY(
      JSON_OBJECT('name', 'name', 'label', 'Name', 'type', 'text', 'required', TRUE, 'role', 'name', 'width', 'half'),
      JSON_OBJECT('name', 'email', 'label', 'Email', 'type', 'email', 'required', TRUE, 'role', 'email', 'width', 'half'),
      JSON_OBJECT('name', 'phone', 'label', 'Phone (optional)', 'type', 'tel', 'role', 'phone'),
      JSON_OBJECT('name', 'project_id', 'label', 'Project', 'type', 'hidden', 'defaultValue', CAST(p.id AS CHAR))
    ),
    'submitLabel', LEFT(CONCAT('Email me the ', p.name, ' brochure'), 80),
    'successHeadline', 'Check your inbox.',
    'successBody', 'Your download link is on its way. The link works for 7 days.',
    'actions', JSON_ARRAY(
      JSON_OBJECT(
        'kind', 'deliver_file',
        'file', JSON_OBJECT('media_id', p.brochure_pdf_id, 'alt', LEFT(CONCAT(p.name, ' brochure'), 320)),
        'mode', 'email',
        'emailSubject', LEFT(CONCAT('Your ', p.name, ' brochure'), 160),
        'emailBody', LEFT(CONCAT('Thanks for your interest in ', p.name, ' — here is the full brochure.'), 800)
      )
    )
  ),
  cb.draft_data = CASE WHEN cb.draft_data IS NOT NULL AND JSON_VALID(cb.draft_data) THEN
    JSON_OBJECT(
      'heading', 'The complete dossier, sent to your inbox',
      'intro', LEFT(COALESCE(NULLIF(TRIM(CASE WHEN JSON_TYPE(JSON_EXTRACT(cb.draft_data, '$.gate_message_richtext')) = 'STRING' THEN REGEXP_REPLACE(JSON_UNQUOTE(JSON_EXTRACT(cb.draft_data, '$.gate_message_richtext')), '<[^>]*>', ' ') END), ''), 'We''ll email you a download link with the full brochure, including pricing, plans, and the neighbourhood guide. The link works for 7 days.'), 800),
      'fields', JSON_ARRAY(
        JSON_OBJECT('name', 'name', 'label', 'Name', 'type', 'text', 'required', TRUE, 'role', 'name', 'width', 'half'),
        JSON_OBJECT('name', 'email', 'label', 'Email', 'type', 'email', 'required', TRUE, 'role', 'email', 'width', 'half'),
        JSON_OBJECT('name', 'phone', 'label', 'Phone (optional)', 'type', 'tel', 'role', 'phone'),
        JSON_OBJECT('name', 'project_id', 'label', 'Project', 'type', 'hidden', 'defaultValue', CAST(p.id AS CHAR))
      ),
      'submitLabel', LEFT(CONCAT('Email me the ', p.name, ' brochure'), 80),
      'successHeadline', 'Check your inbox.',
      'successBody', 'Your download link is on its way. The link works for 7 days.',
      'actions', JSON_ARRAY(
        JSON_OBJECT(
          'kind', 'deliver_file',
          'file', JSON_OBJECT('media_id', p.brochure_pdf_id, 'alt', LEFT(CONCAT(p.name, ' brochure'), 320)),
          'mode', 'email',
          'emailSubject', LEFT(CONCAT('Your ', p.name, ' brochure'), 160),
          'emailBody', LEFT(CONCAT('Thanks for your interest in ', p.name, ' — here is the full brochure.'), 800)
        )
      )
    )
  ELSE cb.draft_data END,
  cb.block_type = 'lx_form'
WHERE cb.block_type = 'lx_brochure_form';
--> statement-breakpoint

-- Remaining lx_brochure_form rows = no live project OR no brochure PDF
-- (the legacy renderer rendered nothing). Convert + soft-delete, same
-- rationale as the inquiry orphans.
UPDATE content_blocks cb
SET
  cb.data = JSON_OBJECT(
    'heading', 'The complete dossier, sent to your inbox',
    'fields', JSON_ARRAY(
      JSON_OBJECT('name', 'name', 'label', 'Name', 'type', 'text', 'required', TRUE, 'role', 'name', 'width', 'half'),
      JSON_OBJECT('name', 'email', 'label', 'Email', 'type', 'email', 'required', TRUE, 'role', 'email', 'width', 'half'),
      JSON_OBJECT('name', 'phone', 'label', 'Phone (optional)', 'type', 'tel', 'role', 'phone')
    ),
    'submitLabel', 'Email me the brochure',
    'actions', JSON_ARRAY()
  ),
  cb.draft_data = NULL,
  cb.block_type = 'lx_form',
  cb.deleted_at = COALESCE(cb.deleted_at, NOW(3))
WHERE cb.block_type = 'lx_brochure_form';
--> statement-breakpoint

-- Reverse-index the snapshotted brochure media on the converted blocks
-- so the media library's delete protection sees the block-level
-- reference (the project-row reference alone would let an operator who
-- clears the project's PDF then delete media a live form still gates).
INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
SELECT m.id, 'content_block', cb.id, 'actions[0].file.media_id'
FROM content_blocks cb
JOIN media m ON m.id = CAST(JSON_EXTRACT(cb.data, '$.actions[0].file.media_id') AS UNSIGNED)
WHERE cb.block_type = 'lx_form'
  AND cb.deleted_at IS NULL
  AND JSON_TYPE(JSON_EXTRACT(cb.data, '$.actions[0].file.media_id')) = 'INTEGER';

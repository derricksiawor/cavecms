-- 0024_legacy_block_type_to_lx.sql
--
-- The legacy block family is gone. This migration converts every
-- content_blocks row that still carries a legacy block_type to its
-- lx_ equivalent, and deletes rows whose legacy type had no premium
-- analog at all.
--
-- ─── Invariants every UPDATE in this file MUST honour ─────────────
--   1. New `data` JSON contains ONLY fields that exist in the lx_
--      Zod schema. Legacy-only fields are dropped at the rebuild.
--   2. Optional fields with no source value are REMOVED from data
--      (JSON `null` does NOT satisfy Zod `.optional()` — that gate
--      accepts `undefined` only, which over the wire means the key
--      is absent). Pattern: build a JSON_OBJECT with the candidate
--      value, then JSON_REMOVE any path whose value resolved to
--      SQL NULL via a conditional path argument.
--   3. Enum tones are mapped through the legacy → lx_ rename when
--      the new enum doesn't accept the legacy literal (e.g. legacy
--      `near-black` maps to lx_ `obsidian`).
--   4. Per-item fields are renamed via JSON_TABLE + JSON_ARRAYAGG
--      when the legacy item shape differs from the lx_ item shape
--      (icon_list `{icon,label}` → `{icon,headline}`; social_icons
--      `{platform,url}` → `{platform,href}`).
--   5. `family` and `weight` are NEVER set in the migration. The
--      lx_ schemas reject the legacy `font: 'sans'/'serif'` values
--      (the lx_ token vocabulary is `'display'/'body'`). Leaving
--      both unset lets Zod's defaults fill in the renderer's
--      hard-coded baseline, which matches the legacy renderer's
--      effective styling.
--
-- Two passes:
--   PASS 1 — UPDATE every legacy block_type to its lx_ equivalent.
--   PASS 2 — DELETE rows whose legacy type has no lx_ analog
--            (hero / services_intro / featured_projects /
--             about_history / stats_row / star_rating / alert).

-- ════════════════════════════════════════════════════════════════════
-- PASS 1 — UPDATE legacy → lx_*
-- ════════════════════════════════════════════════════════════════════

-- heading → lx_heading
-- Drops legacy `font` (lx_ token vocabulary differs) and `weight`
-- (lx_ vocabulary differs). Zod fills defaults on parse.
UPDATE content_blocks
SET
  block_type = 'lx_heading',
  data = JSON_OBJECT(
    'text',      JSON_VALUE(data, '$.text'),
    'level',     COALESCE(JSON_VALUE(data, '$.level'), 'h2'),
    'alignment', IF(JSON_VALUE(data, '$.alignment') = 'justify',
                    'left',
                    COALESCE(JSON_VALUE(data, '$.alignment'), 'left')),
    'size',      'display-lg',
    'tone',      'obsidian',
    'italic',    false,
    'animation', 'none'
  )
WHERE block_type = 'heading';
--> statement-breakpoint

-- text → lx_text (legacy optional `heading` field is dropped — lx_text
-- has no heading slot. Operator rebuilds via a separate lx_heading
-- preceding the lx_text in the same column if they want one.)
UPDATE content_blocks
SET
  block_type = 'lx_text',
  data = JSON_OBJECT(
    'body_richtext', COALESCE(JSON_VALUE(data, '$.body_richtext'), ''),
    'size',          'body-md',
    'alignment',     'left',
    'tone',          'obsidian',
    'maxWidth',      'medium',
    'animation',     'none'
  )
WHERE block_type = 'text';
--> statement-breakpoint

-- button → lx_action
UPDATE content_blocks
SET
  block_type = 'lx_action',
  data = JSON_OBJECT(
    'label',     JSON_VALUE(data, '$.text'),
    'href',      JSON_VALUE(data, '$.href'),
    'openInNew', COALESCE(JSON_VALUE(data, '$.openInNew'), false),
    'variant',   IF(JSON_VALUE(data, '$.variant') = 'primary',   'primary-gold',
                 IF(JSON_VALUE(data, '$.variant') = 'secondary', 'secondary-outline',
                                                                  'ghost')),
    'size',      IF(JSON_VALUE(data, '$.size') = 'xs', 'sm',
                 IF(JSON_VALUE(data, '$.size') = 'xl', 'lg',
                    COALESCE(JSON_VALUE(data, '$.size'), 'md'))),
    'alignment', COALESCE(JSON_VALUE(data, '$.alignment'), 'left'),
    'animation', 'none'
  )
WHERE block_type = 'button';
--> statement-breakpoint

-- quote → lx_quote
-- attribution_title is concatenated onto attribution so the byline
-- survives. attribution is `.optional()` in the new schema; when
-- both source fields are NULL we emit it as null and JSON_REMOVE
-- strips it (Zod rejects null for `.optional()`).
UPDATE content_blocks
SET
  block_type = 'lx_quote',
  data = JSON_REMOVE(
    JSON_OBJECT(
      'quote', JSON_VALUE(data, '$.quote'),
      'attribution',
        CASE
          WHEN JSON_VALUE(data, '$.attribution') IS NOT NULL
           AND JSON_VALUE(data, '$.attribution_title') IS NOT NULL
          THEN CONCAT(JSON_VALUE(data, '$.attribution'), ', ', JSON_VALUE(data, '$.attribution_title'))
          WHEN JSON_VALUE(data, '$.attribution') IS NOT NULL
          THEN JSON_VALUE(data, '$.attribution')
          WHEN JSON_VALUE(data, '$.attribution_title') IS NOT NULL
          THEN JSON_VALUE(data, '$.attribution_title')
          ELSE NULL
        END,
      'alignment', 'center',
      'tone',      'obsidian',
      'animation', 'none'
    ),
    IF(JSON_VALUE(data, '$.attribution') IS NULL
        AND JSON_VALUE(data, '$.attribution_title') IS NULL,
        '$.attribution', '$.__keep__')
  )
WHERE block_type = 'quote';
--> statement-breakpoint

-- eyebrow → lx_eyebrow
-- Legacy `color` enum: copper / warm-stone / near-black.
-- New `tone` enum:    champagne / obsidian / ivory / warm-stone.
-- Mapping: copper → champagne (champagne is the new gold accent);
-- near-black → obsidian (the new dark token); warm-stone passes.
UPDATE content_blocks
SET
  block_type = 'lx_eyebrow',
  data = JSON_OBJECT(
    'text',      JSON_VALUE(data, '$.text'),
    'tone',      IF(JSON_VALUE(data, '$.color') = 'copper',     'champagne',
                 IF(JSON_VALUE(data, '$.color') = 'near-black', 'obsidian',
                    COALESCE(JSON_VALUE(data, '$.color'), 'champagne'))),
    'alignment', COALESCE(JSON_VALUE(data, '$.alignment'), 'left'),
    'prefix',    'none',
    'animation', 'none'
  )
WHERE block_type = 'eyebrow';
--> statement-breakpoint

-- spacer → lx_space (prefix rename xs..2xl → section-xs..section-2xl)
UPDATE content_blocks
SET
  block_type = 'lx_space',
  data = JSON_OBJECT(
    'size', CONCAT('section-', COALESCE(JSON_VALUE(data, '$.height'), 'md'))
  )
WHERE block_type = 'spacer';
--> statement-breakpoint

-- divider → lx_divider
-- Legacy color enum: copper / warm-stone / near-black.
-- New tone enum:     champagne / warm-stone / copper / obsidian / ivory.
-- Mapping: near-black → obsidian; copper + warm-stone pass.
UPDATE content_blocks
SET
  block_type = 'lx_divider',
  data = JSON_OBJECT(
    'style',     IF(JSON_VALUE(data, '$.style') IN ('solid','dashed','dotted'),
                    JSON_VALUE(data, '$.style'),
                    'solid'),
    'width',     COALESCE(JSON_VALUE(data, '$.width'), 'full'),
    'thickness', IF(JSON_VALUE(data, '$.thickness') = '4px', '2px',
                    COALESCE(JSON_VALUE(data, '$.thickness'), 'hairline')),
    'tone',      IF(JSON_VALUE(data, '$.color') = 'near-black', 'obsidian',
                    COALESCE(JSON_VALUE(data, '$.color'), 'champagne')),
    'alignment', COALESCE(JSON_VALUE(data, '$.alignment'), 'center'),
    'animation', 'none'
  )
WHERE block_type = 'divider';
--> statement-breakpoint

-- icon_box → lx_icon_box
-- accent rename: copper-filled  → champagne-fill,
--                copper-outline → champagne-outline,
--                cream-tint     → cream-tint.
-- tone rename:   near-black     → obsidian, ivory → ivory.
-- body + link are optional; null-strip via JSON_REMOVE pattern.
UPDATE content_blocks
SET
  block_type = 'lx_icon_box',
  data = JSON_REMOVE(
    JSON_OBJECT(
      'icon',      JSON_VALUE(data, '$.icon'),
      'headline',  JSON_VALUE(data, '$.headline'),
      'body',      JSON_VALUE(data, '$.body'),
      'link',      JSON_EXTRACT(data, '$.link'),
      'alignment', COALESCE(JSON_VALUE(data, '$.alignment'), 'center'),
      'accent',    IF(JSON_VALUE(data, '$.accent') = 'copper-filled',  'champagne-fill',
                   IF(JSON_VALUE(data, '$.accent') = 'copper-outline', 'champagne-outline',
                      COALESCE(JSON_VALUE(data, '$.accent'), 'champagne-outline'))),
      'tone',      IF(JSON_VALUE(data, '$.tone') = 'near-black', 'obsidian',
                      COALESCE(JSON_VALUE(data, '$.tone'), 'obsidian')),
      'animation', 'none'
    ),
    IF(JSON_VALUE(data, '$.body') IS NULL, '$.body', '$.__keep_body__'),
    IF(JSON_EXTRACT(data, '$.link') IS NULL, '$.link', '$.__keep_link__')
  )
WHERE block_type = 'icon_box';
--> statement-breakpoint

-- accordion → lx_accordion
UPDATE content_blocks
SET
  block_type = 'lx_accordion',
  data = JSON_OBJECT(
    'items',       JSON_EXTRACT(data, '$.items'),
    'defaultOpen', 0,
    'variant',     'accordion',
    'tone',        'obsidian',
    'animation',   'none'
  )
WHERE block_type = 'accordion';
--> statement-breakpoint

-- tabs → lx_tabs (legacy `items` field renamed to `tabs`).
UPDATE content_blocks
SET
  block_type = 'lx_tabs',
  data = JSON_OBJECT(
    'tabs',         JSON_EXTRACT(data, '$.items'),
    'defaultIndex', 0,
    'alignment',    'left',
    'tone',         'obsidian',
    'animation',    'none'
  )
WHERE block_type = 'tabs';
--> statement-breakpoint

-- icon_list → lx_icon_list
-- Per-item rebuild: legacy `{icon, label}` → new `{icon, headline}`.
-- JSON_TABLE explodes the legacy items array into rows; JSON_ARRAYAGG
-- recomposes them in the new item shape. Subquery is correlated by
-- block id so each row sees its own legacy data.
UPDATE content_blocks AS cb
SET
  block_type = 'lx_icon_list',
  data = JSON_OBJECT(
    'items', (
      SELECT JSON_ARRAYAGG(JSON_OBJECT('icon', it.icon, 'headline', it.label))
      FROM JSON_TABLE(
        cb.data,
        '$.items[*]' COLUMNS (
          icon  VARCHAR(60)  PATH '$.icon',
          label VARCHAR(220) PATH '$.label'
        )
      ) AS it
    ),
    'variant',   'vertical',
    'columns',   3,
    'alignment', 'left',
    'tone',      'obsidian',
    'animation', 'none'
  )
WHERE block_type = 'icon_list';
--> statement-breakpoint

-- testimonial → lx_testimonial
-- legacy `role` → attribution_title; legacy `image` (portrait MediaRef)
-- → portrait. Both are optional in lx_; null-strip via JSON_REMOVE.
UPDATE content_blocks
SET
  block_type = 'lx_testimonial',
  data = JSON_REMOVE(
    JSON_OBJECT(
      'quote',             JSON_VALUE(data, '$.quote'),
      'attribution',       COALESCE(JSON_VALUE(data, '$.attribution'), 'Anonymous'),
      'attribution_title', JSON_VALUE(data, '$.role'),
      'portrait',          JSON_EXTRACT(data, '$.image'),
      'alignment',         'center',
      'tone',              'obsidian',
      'animation',         'none'
    ),
    IF(JSON_VALUE(data, '$.role') IS NULL, '$.attribution_title', '$.__keep_title__'),
    IF(JSON_EXTRACT(data, '$.image') IS NULL, '$.portrait', '$.__keep_portrait__')
  )
WHERE block_type = 'testimonial';
--> statement-breakpoint

-- video_embed → lx_video (aspect_ratio → ratio; caption optional)
UPDATE content_blocks
SET
  block_type = 'lx_video',
  data = JSON_REMOVE(
    JSON_OBJECT(
      'url',      JSON_VALUE(data, '$.url'),
      'ratio',    COALESCE(JSON_VALUE(data, '$.aspect_ratio'), '16:9'),
      'caption',  JSON_VALUE(data, '$.caption'),
      'autoplay', false,
      'muted',    true,
      'loop',     false,
      'tone',     'obsidian',
      'animation','none'
    ),
    IF(JSON_VALUE(data, '$.caption') IS NULL, '$.caption', '$.__keep_caption__')
  )
WHERE block_type = 'video_embed';
--> statement-breakpoint

-- image → lx_figure (legacy alignment dropped; caption optional)
UPDATE content_blocks
SET
  block_type = 'lx_figure',
  data = JSON_REMOVE(
    JSON_OBJECT(
      'image',       JSON_EXTRACT(data, '$.image'),
      'ratio',       '16:9',
      'fit',         'cover',
      'caption',     JSON_VALUE(data, '$.caption'),
      'goldOverlay', false,
      'corners',     'sharp',
      'animation',   'none'
    ),
    IF(JSON_VALUE(data, '$.caption') IS NULL, '$.caption', '$.__keep_caption__')
  )
WHERE block_type = 'image';
--> statement-breakpoint

-- gallery → lx_gallery (images array carries verbatim with captions)
UPDATE content_blocks
SET
  block_type = 'lx_gallery',
  data = JSON_OBJECT(
    'images',    JSON_EXTRACT(data, '$.images'),
    'columns',   COALESCE(JSON_VALUE(data, '$.columns'), 3),
    'ratio',     '1:1',
    'tone',      'obsidian',
    'animation', 'none'
  )
WHERE block_type = 'gallery';
--> statement-breakpoint

-- cta (banner) → lx_cta_banner
-- title + body + cta sub-object → title + body + primaryCta.
-- body is optional on the new schema; null-strip via JSON_REMOVE.
UPDATE content_blocks
SET
  block_type = 'lx_cta_banner',
  data = JSON_REMOVE(
    JSON_OBJECT(
      'title',      JSON_VALUE(data, '$.title'),
      'body',       JSON_VALUE(data, '$.body'),
      'primaryCta', JSON_OBJECT(
        'label',     COALESCE(JSON_VALUE(data, '$.cta.text'), 'Learn more'),
        'href',      COALESCE(JSON_VALUE(data, '$.cta.href'), '/contact'),
        'openInNew', COALESCE(JSON_VALUE(data, '$.cta.openInNew'), false)
      ),
      'alignment', 'center',
      'tone',      'obsidian',
      'animation', 'none'
    ),
    IF(JSON_VALUE(data, '$.body') IS NULL, '$.body', '$.__keep_body__')
  )
WHERE block_type = 'cta';
--> statement-breakpoint

-- channel_card → lx_channel_card
-- body → description; lx requires `value` so we mirror label into it.
-- description + href are optional; null-strip via JSON_REMOVE.
UPDATE content_blocks
SET
  block_type = 'lx_channel_card',
  data = JSON_REMOVE(
    JSON_OBJECT(
      'label',       JSON_VALUE(data, '$.label'),
      'value',       JSON_VALUE(data, '$.label'),
      'description', JSON_VALUE(data, '$.body'),
      'href',        JSON_VALUE(data, '$.action.href'),
      'tone',        'obsidian'
    ),
    IF(JSON_VALUE(data, '$.body') IS NULL, '$.description', '$.__keep_desc__'),
    IF(JSON_VALUE(data, '$.action.href') IS NULL, '$.href', '$.__keep_href__')
  )
WHERE block_type = 'channel_card';
--> statement-breakpoint

-- social_icons → lx_social_icons
-- Per-item rebuild: legacy `{platform, url}` → new `{platform, href}`.
-- The lx_ enum is strict; legacy rows with an unknown platform name
-- will be skipped at render-time when Zod re-parses. Since CaveCMS
-- has no shipping customers yet, this is acceptable.
UPDATE content_blocks AS cb
SET
  block_type = 'lx_social_icons',
  data = JSON_OBJECT(
    'items', (
      SELECT JSON_ARRAYAGG(JSON_OBJECT('platform', it.platform, 'href', it.url))
      FROM JSON_TABLE(
        cb.data,
        '$.items[*]' COLUMNS (
          platform VARCHAR(40)  PATH '$.platform',
          url      VARCHAR(2000) PATH '$.url'
        )
      ) AS it
    ),
    'size',      'md',
    'alignment', 'center',
    'tone',      'warm-stone',
    'animation', 'none'
  )
WHERE block_type = 'social_icons';
--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════
-- PASS 2 — DELETE rows whose legacy type has no lx_ analog
-- ════════════════════════════════════════════════════════════════════

DELETE FROM content_blocks WHERE block_type = 'hero';
--> statement-breakpoint

DELETE FROM content_blocks WHERE block_type IN ('services_intro', 'featured_projects', 'about_history');
--> statement-breakpoint

-- stats_row — 1→N split into lx_stat rows is unsafe in SQL. Operator
-- rebuilds via the palette (3× lx_stat in a threeCols section).
DELETE FROM content_blocks WHERE block_type = 'stats_row';
--> statement-breakpoint

-- star_rating + alert — rare on public pages and no lx_ analog.
DELETE FROM content_blocks WHERE block_type IN ('star_rating', 'alert');
--> statement-breakpoint

-- Audit trail. A row in audit_log records this migration ran on this
-- install. Useful in incident review if a rendering regression
-- surfaces in the days after cutover.
INSERT INTO audit_log (user_id, action, resource_type, resource_id, diff, created_at)
VALUES (
  NULL,
  'migration.run',
  'system',
  '0024_legacy_block_type_to_lx',
  JSON_OBJECT(
    'pass1_pairs', JSON_ARRAY(
      'heading→lx_heading','text→lx_text','button→lx_action','quote→lx_quote',
      'eyebrow→lx_eyebrow','spacer→lx_space','divider→lx_divider','icon_box→lx_icon_box',
      'accordion→lx_accordion','tabs→lx_tabs','icon_list→lx_icon_list',
      'testimonial→lx_testimonial','video_embed→lx_video','image→lx_figure',
      'gallery→lx_gallery','cta→lx_cta_banner','channel_card→lx_channel_card',
      'social_icons→lx_social_icons'
    ),
    'pass2_deletes', JSON_ARRAY(
      'hero','services_intro','featured_projects','about_history',
      'stats_row','star_rating','alert'
    )
  ),
  NOW(3)
);

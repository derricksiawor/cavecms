-- §18: seed The Kharis as a regular (non-system) CMS page + its
-- supporting media library.
--
-- The Kharis is Best World's flagship Spintex Manet development —
-- 25 detached 3 & 4 bedroom townhouses with all-ensuite boys'
-- quarters. The live source page (bestworldcompany.com/the-kharis/)
-- is sparse and image-heavy; the local rebuild composes the same
-- material into the luxury-redesign block system (obsidian sections,
-- champagne eyebrows, photo-tile amenities), adding CTAs that the
-- source page lacks and a Google Maps embed for the location.
--
-- Storage shape: this is a NON-system page (`system = 0`) so an
-- operator can rename / unpublish / soft-delete it through the
-- admin UI without the system-page guards engaging. The dynamic
-- `/_page/[slug]` resolver serves it via the middleware rewrite —
-- no code change to `app/_shared/cmsPage.ts` or to the
-- `CmsPageSlug` union is required.
--
-- Media: ten photos downloaded from the live source page into
-- `public/uploads/the-kharis/` (hero exterior + 8 amenity tiles +
-- the payments-plan editorial photo). Each row uses the same
-- "legacy variants" pattern as the other 0010-era seed rows —
-- every variant key points at the original PNG; the renderer's
-- `<picture>` falls back gracefully. Pre-generating WebP variants
-- via sharp is intentionally out-of-scope for this migration
-- (the operator's variant generator runs on upload, not on seed).
--
-- post-migrate-asserts.ts: this migration does NOT change the
-- system-page count (it inserts `system = 0`), and the slug
-- allow-list is system-scoped. No assert update required.
--
-- ─── 1. Page row ────────────────────────────────────────────────
INSERT INTO pages
  (slug, title, is_home, system, published, published_at, seo_title, seo_description, created_at)
VALUES
  (
    'the-kharis',
    'The Kharis',
    0,
    0,
    1,
    NOW(3),
    'The Kharis — 3 & 4 Bedroom Detached Townhouses, Spintex',
    'An exclusive gated community of 25 detached 3 & 4 bedroom townhouses in Spintex Manet, Accra. Crafted by Best World Properties with premium amenities, flexible payment plans, and 24/7 security.',
    NOW(3)
  )
ON DUPLICATE KEY UPDATE
  title         = VALUES(title),
  published     = 1,
  published_at  = COALESCE(pages.published_at, VALUES(published_at)),
  seo_title     = VALUES(seo_title),
  seo_description = VALUES(seo_description);

-- ─── 2. Media rows ──────────────────────────────────────────────
-- Stable `filename_uuid` values so the seed function can look up
-- the auto-incremented media.id by name (instead of hardcoding the
-- numeric id — which differs between fresh and incremental DBs).
-- Each variants JSON points at the same original file across all
-- four keys, matching rows 5-31 in the existing media table.
INSERT INTO media
  (filename_uuid, original_name, mime_type, alt_text, byte_size, variants, created_at)
VALUES
  (
    'kharis-2026-kh1',
    'kharis-kh1.png',
    'image/png',
    'Front exterior of a The Kharis townhouse — modern white facade with wood accents and a paved driveway in Spintex Manet',
    533651,
    '{"thumb": "/uploads/the-kharis/kh1.png", "md": "/uploads/the-kharis/kh1.png", "lg": "/uploads/the-kharis/kh1.png", "og": "/uploads/the-kharis/kh1.png"}',
    NOW(3)
  ),
  (
    'kharis-2026-gated',
    'kharis-gated.png',
    'image/png',
    'Aerial view of The Kharis gated community access road with manicured landscaping',
    543529,
    '{"thumb": "/uploads/the-kharis/gated.png", "md": "/uploads/the-kharis/gated.png", "lg": "/uploads/the-kharis/gated.png", "og": "/uploads/the-kharis/gated.png"}',
    NOW(3)
  ),
  (
    'kharis-2026-swim',
    'kharis-swim.png',
    'image/png',
    'Family enjoying the community swimming pool at The Kharis on a sunny afternoon',
    737273,
    '{"thumb": "/uploads/the-kharis/swim.png", "md": "/uploads/the-kharis/swim.png", "lg": "/uploads/the-kharis/swim.png", "og": "/uploads/the-kharis/swim.png"}',
    NOW(3)
  ),
  (
    'kharis-2026-gym',
    'kharis-gym.png',
    'image/png',
    'Resident training on equipment inside The Kharis on-site fitness centre',
    669137,
    '{"thumb": "/uploads/the-kharis/gyymm.png", "md": "/uploads/the-kharis/gyymm.png", "lg": "/uploads/the-kharis/gyymm.png", "og": "/uploads/the-kharis/gyymm.png"}',
    NOW(3)
  ),
  (
    'kharis-2026-garden',
    'kharis-garden.png',
    'image/png',
    'Open landscaped gardens at The Kharis with mature trees and well-kept lawns',
    669445,
    '{"thumb": "/uploads/the-kharis/gard.png", "md": "/uploads/the-kharis/gard.png", "lg": "/uploads/the-kharis/gard.png", "og": "/uploads/the-kharis/gard.png"}',
    NOW(3)
  ),
  (
    'kharis-2026-electric',
    'kharis-electric.png',
    'image/png',
    'Hand on a backup-power remote — uninterrupted 24-hour electricity at The Kharis',
    576460,
    '{"thumb": "/uploads/the-kharis/electr.png", "md": "/uploads/the-kharis/electr.png", "lg": "/uploads/the-kharis/electr.png", "og": "/uploads/the-kharis/electr.png"}',
    NOW(3)
  ),
  (
    'kharis-2026-water',
    'kharis-water.png',
    'image/png',
    'Clean water pouring from a tap — uninterrupted on-site water reserve at The Kharis',
    902849,
    '{"thumb": "/uploads/the-kharis/wreserve.png", "md": "/uploads/the-kharis/wreserve.png", "lg": "/uploads/the-kharis/wreserve.png", "og": "/uploads/the-kharis/wreserve.png"}',
    NOW(3)
  ),
  (
    'kharis-2026-security',
    'kharis-security.png',
    'image/png',
    'Uniformed security officer in a hi-vis vest at The Kharis 24/7 community checkpoint',
    490340,
    '{"thumb": "/uploads/the-kharis/security.png", "md": "/uploads/the-kharis/security.png", "lg": "/uploads/the-kharis/security.png", "og": "/uploads/the-kharis/security.png"}',
    NOW(3)
  ),
  (
    'kharis-2026-facilities',
    'kharis-facilities.png',
    'image/png',
    'Best World facility-management technician on site at The Kharis',
    774406,
    '{"thumb": "/uploads/the-kharis/facilities.png", "md": "/uploads/the-kharis/facilities.png", "lg": "/uploads/the-kharis/facilities.png", "og": "/uploads/the-kharis/facilities.png"}',
    NOW(3)
  ),
  (
    'kharis-2026-payments',
    'kharis-payments.png',
    'image/png',
    'Hands holding eyeglasses and a phone over financial paperwork — flexible payment plans for The Kharis',
    538865,
    '{"thumb": "/uploads/the-kharis/payments.png", "md": "/uploads/the-kharis/payments.png", "lg": "/uploads/the-kharis/payments.png", "og": "/uploads/the-kharis/payments.png"}',
    NOW(3)
  )
ON DUPLICATE KEY UPDATE
  original_name = VALUES(original_name),
  alt_text      = VALUES(alt_text),
  byte_size     = VALUES(byte_size),
  variants      = VALUES(variants);

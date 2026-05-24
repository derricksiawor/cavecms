-- §20: seed the two remaining project landing pages (Mantebea
-- Gardens + Anowaa Gardens) as CMS pages, mirroring the §18 shape
-- the Kharis landing established.
--
-- Both already exist as rows in the `projects` table (ids 65 / 66
-- per migration 0011-era seeds). The `/projects/[slug]` route now
-- prefers a matching `pages` row at the same slug — once these
-- rows + their seeded block trees land, both project URLs serve
-- the CMS render path instead of the legacy `project_sections`
-- layout, completing the migration off the legacy system for
-- every published project.
--
-- Media rows reuse the §18 'kharis-2026-*' filename_uuids where
-- the underlying photo is shared (electr / security / facilities /
-- gated.png). For the photos that DIFFER between projects we add
-- new media rows with project-scoped prefixes:
--   - 'mante-2026-*'   for Mantebea Gardens
--   - 'anow-2026-*'    for Anowaa Gardens
--
-- Hero images use the existing media rows already inserted for the
-- /projects index featured-cards (mantebea-cover = media_id 25,
-- anowaa-cover = media_id 26) so no additional hero media is needed.
--
-- ─── 1. Page rows ───────────────────────────────────────────────
INSERT INTO pages
  (slug, title, is_home, system, published, published_at, seo_title, seo_description, created_at)
VALUES
  (
    'mantebea-gardens',
    'Mantebea Gardens',
    0,
    0,
    1,
    NOW(3),
    'Mantebea Gardens — 3, 4 & 5 Bedroom Townhouses, Amrahia',
    'A vibrant gated community in Amrahia on Katamanso Road. 3-bedroom single-storey and 3-5 bedroom double-storey townhouses by Best World Properties, designed for the long view.',
    NOW(3)
  ),
  (
    'anowaa-gardens',
    'Anowaa Gardens',
    0,
    0,
    1,
    NOW(3),
    'Anowaa Gardens — Six 3-Bedroom Detached Townhouses, Spintex',
    'Six exclusive 3-bedroom detached townhouses in Spintex Manet, behind the Ghana International Mall. Luxury living and a smart investment in one of Accra most desirable corridors.',
    NOW(3)
  )
ON DUPLICATE KEY UPDATE
  title         = VALUES(title),
  published     = 1,
  published_at  = COALESCE(pages.published_at, VALUES(published_at)),
  seo_title     = VALUES(seo_title),
  seo_description = VALUES(seo_description);

-- ─── 2. Mantebea Gardens media rows ─────────────────────────────
-- Eight project-specific photos. Hero uses the existing media_id 25
-- (mantebea-cover.png in /uploads/projects/) — no new hero row.
INSERT INTO media
  (filename_uuid, original_name, mime_type, alt_text, byte_size, variants, created_at)
VALUES
  (
    'mante-2026-interior',
    'mantebea-interior.png',
    'image/png',
    'Modern double-storey Mantebea Gardens home interior with a contemporary staircase and open living plan',
    434349,
    '{"thumb": "/uploads/mantebea-gardens/inte-550x825.png", "md": "/uploads/mantebea-gardens/inte-550x825.png", "lg": "/uploads/mantebea-gardens/inte-550x825.png", "og": "/uploads/mantebea-gardens/inte-550x825.png"}',
    NOW(3)
  ),
  (
    'mante-2026-gated',
    'mantebea-gated.png',
    'image/png',
    'Aerial of the Mantebea Gardens gated community entrance with manicured landscaping',
    680379,
    '{"thumb": "/uploads/mantebea-gardens/gatedcomm.png", "md": "/uploads/mantebea-gardens/gatedcomm.png", "lg": "/uploads/mantebea-gardens/gatedcomm.png", "og": "/uploads/mantebea-gardens/gatedcomm.png"}',
    NOW(3)
  ),
  (
    'mante-2026-swim',
    'mantebea-swim.png',
    'image/png',
    'Mantebea Gardens community swimming pool on a sunny afternoon',
    782400,
    '{"thumb": "/uploads/mantebea-gardens/swimpool.png", "md": "/uploads/mantebea-gardens/swimpool.png", "lg": "/uploads/mantebea-gardens/swimpool.png", "og": "/uploads/mantebea-gardens/swimpool.png"}',
    NOW(3)
  ),
  (
    'mante-2026-gym',
    'mantebea-gym.png',
    'image/png',
    'Mantebea Gardens on-site fitness centre with modern equipment',
    861274,
    '{"thumb": "/uploads/mantebea-gardens/fitnessgym.png", "md": "/uploads/mantebea-gardens/fitnessgym.png", "lg": "/uploads/mantebea-gardens/fitnessgym.png", "og": "/uploads/mantebea-gardens/fitnessgym.png"}',
    NOW(3)
  ),
  (
    'mante-2026-garden',
    'mantebea-garden.png',
    'image/png',
    'Landscaped gardens and outdoor seating at Mantebea Gardens',
    1169518,
    '{"thumb": "/uploads/mantebea-gardens/gradenn.png", "md": "/uploads/mantebea-gardens/gradenn.png", "lg": "/uploads/mantebea-gardens/gradenn.png", "og": "/uploads/mantebea-gardens/gradenn.png"}',
    NOW(3)
  ),
  (
    'mante-2026-security',
    'mantebea-security.png',
    'image/png',
    'Security checkpoint at Mantebea Gardens with a uniformed officer',
    577474,
    '{"thumb": "/uploads/mantebea-gardens/security01.png", "md": "/uploads/mantebea-gardens/security01.png", "lg": "/uploads/mantebea-gardens/security01.png", "og": "/uploads/mantebea-gardens/security01.png"}',
    NOW(3)
  ),
  (
    'mante-2026-waste',
    'mantebea-waste.png',
    'image/png',
    'Communal waste-management bins at Mantebea Gardens',
    716712,
    '{"thumb": "/uploads/mantebea-gardens/vacu.png", "md": "/uploads/mantebea-gardens/vacu.png", "lg": "/uploads/mantebea-gardens/vacu.png", "og": "/uploads/mantebea-gardens/vacu.png"}',
    NOW(3)
  ),
  (
    'mante-2026-water',
    'mantebea-water.png',
    'image/png',
    'On-site water reservoir tower at Mantebea Gardens',
    790831,
    '{"thumb": "/uploads/mantebea-gardens/reservior.png", "md": "/uploads/mantebea-gardens/reservior.png", "lg": "/uploads/mantebea-gardens/reservior.png", "og": "/uploads/mantebea-gardens/reservior.png"}',
    NOW(3)
  )
ON DUPLICATE KEY UPDATE
  original_name = VALUES(original_name),
  alt_text      = VALUES(alt_text),
  byte_size     = VALUES(byte_size),
  variants      = VALUES(variants);

-- ─── 3. Anowaa Gardens media rows ───────────────────────────────
-- Four project-specific photos. Hero uses the existing media_id 26
-- (anowaa-cover.png in /uploads/projects/) — no new hero row.
INSERT INTO media
  (filename_uuid, original_name, mime_type, alt_text, byte_size, variants, created_at)
VALUES
  (
    'anow-2026-bedroom',
    'anowaa-bedroom.png',
    'image/png',
    'Elegant master bedroom interior at Anowaa Gardens with premium finishes',
    614157,
    '{"thumb": "/uploads/anowaa-gardens/bedy.png", "md": "/uploads/anowaa-gardens/bedy.png", "lg": "/uploads/anowaa-gardens/bedy.png", "og": "/uploads/anowaa-gardens/bedy.png"}',
    NOW(3)
  ),
  (
    'anow-2026-garden',
    'anowaa-garden.png',
    'image/png',
    'Manicured garden walkway at Anowaa Gardens',
    836245,
    '{"thumb": "/uploads/anowaa-gardens/gardenar.png", "md": "/uploads/anowaa-gardens/gardenar.png", "lg": "/uploads/anowaa-gardens/gardenar.png", "og": "/uploads/anowaa-gardens/gardenar.png"}',
    NOW(3)
  ),
  (
    'anow-2026-water',
    'anowaa-water.png',
    'image/png',
    'On-site water reservoir at Anowaa Gardens',
    569624,
    '{"thumb": "/uploads/anowaa-gardens/reserviorrr.png", "md": "/uploads/anowaa-gardens/reserviorrr.png", "lg": "/uploads/anowaa-gardens/reserviorrr.png", "og": "/uploads/anowaa-gardens/reserviorrr.png"}',
    NOW(3)
  ),
  (
    'anow-2026-recreation',
    'anowaa-recreation.png',
    'image/png',
    'Communal outdoor seating area at Anowaa Gardens with covered chairs',
    699113,
    '{"thumb": "/uploads/anowaa-gardens/chapay.png", "md": "/uploads/anowaa-gardens/chapay.png", "lg": "/uploads/anowaa-gardens/chapay.png", "og": "/uploads/anowaa-gardens/chapay.png"}',
    NOW(3)
  )
ON DUPLICATE KEY UPDATE
  original_name = VALUES(original_name),
  alt_text      = VALUES(alt_text),
  byte_size     = VALUES(byte_size),
  variants      = VALUES(variants);

// Idempotent additive migration: bring the live `/contact` page's CMS
// tree up to the current seed shape. Adds two pieces:
//
//   (a) a new "Visit us" section with eyebrow + heading + lx_map,
//       inserted between the Split Lead Capture (section 2) and the
//       Trust Strip (section 3 in the seed numbering).
//
//   (b) a `social_icons` widget appended to the end of the Split Lead
//       Capture's channels column (the second of its two columns,
//       which already contains 3 lx_channel_cards).
//
// Idempotency:
//   - skips (a) if ANY lx_map widget already exists on the contact page
//   - skips (b) if ANY social_icons widget already exists in the
//     channels column
//
// Safe to re-run on every deploy. Idempotent guards mean repeated
// invocation is a no-op once both pieces have been seeded.
//
// Run with:
//   node --conditions=react-server --env-file=.env.local --import tsx \
//     scripts/add-contact-map-and-social.ts
//
// --conditions=react-server resolves the `server-only` import to its
// no-op react-server shim (the block-registry imports it). Same flag
// the db:fingerprint / db:check scripts use.

// Defence-in-depth NODE_ENV guard — this is a one-shot data migration.
// Even though the body is idempotent, prod operators should opt-in
// explicitly (via CAVECMS_DATAMIGRATION_OK=1) so accidental invocations
// from a shared shell session can't fire against the live DB.
if (
  process.env['NODE_ENV'] === 'production' &&
  process.env['CAVECMS_DATAMIGRATION_OK'] !== '1'
) {
  console.error(
    '[add-contact-map-and-social] refusing to run with NODE_ENV=production. ' +
      'Set CAVECMS_DATAMIGRATION_OK=1 to override.',
  )
  process.exit(1)
}

import { sql } from 'drizzle-orm'
import { db, pool } from '@/db/client-node'
import { parseAndSanitize } from '@/lib/cms/parse'
import type { BlockKind } from '@/lib/cms/blockMeta'

interface BlockRow {
  id: number
  parent_id: number | null
  kind: BlockKind
  block_type: string
  position: number
}

// Plus code form drops the red pin (the free-text "Bestworld
// Properties Limited" name didn't resolve to a pinned place in the
// embed engine — only centred the map). JVJC+FFW Accra is the canonical
// plus code for BESTWORLD PROPERTIES LIMITED per the share dialog.
const MAP_EMBED_URL =
  'https://maps.google.com/maps?q=JVJC%2BFFW+Accra&z=17&output=embed'

async function getContactPageId(): Promise<number | null> {
  const [rows] = (await db.execute(sql`
    SELECT id FROM pages
    WHERE system = 1 AND slug = 'contact' AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as [Array<{ id: number }>]
  return rows[0]?.id ?? null
}

async function listLiveBlocks(pageId: number): Promise<BlockRow[]> {
  const [rows] = (await db.execute(sql`
    SELECT id, parent_id, kind, block_type, position
    FROM content_blocks
    WHERE page_id = ${pageId} AND deleted_at IS NULL
    ORDER BY position ASC
  `)) as unknown as [BlockRow[]]
  return rows.map((r) => ({
    id: Number(r.id),
    parent_id: r.parent_id == null ? null : Number(r.parent_id),
    kind: r.kind,
    block_type: r.block_type,
    position: Number(r.position),
  }))
}

async function insertWidget(
  pageId: number,
  parentColumnId: number,
  blockType: string,
  data: Record<string, unknown>,
  position: number,
  meta: Record<string, unknown> | null,
): Promise<number> {
  const sanitized = parseAndSanitize(blockType, data) as Record<string, unknown>
  const metaJson = meta ? JSON.stringify(meta) : null
  const [res] = (await db.execute(sql`
    INSERT INTO content_blocks
      (page_id, parent_id, kind, block_key, block_type, position, data, meta, version)
    VALUES
      (${pageId}, ${parentColumnId}, 'widget', NULL, ${blockType}, ${position},
       ${JSON.stringify(sanitized)}, ${metaJson}, 0)
  `)) as unknown as [{ insertId: number | bigint }]
  return Number(res.insertId)
}

async function insertSection(
  pageId: number,
  metaJson: string,
  position: number,
): Promise<number> {
  const [res] = (await db.execute(sql`
    INSERT INTO content_blocks
      (page_id, parent_id, kind, block_key, block_type, position, data, meta, version)
    VALUES
      (${pageId}, NULL, 'section', NULL, 'section', ${position}, '{}', ${metaJson}, 0)
  `)) as unknown as [{ insertId: number | bigint }]
  return Number(res.insertId)
}

async function insertColumn(
  pageId: number,
  sectionId: number,
  position: number,
): Promise<number> {
  const [res] = (await db.execute(sql`
    INSERT INTO content_blocks
      (page_id, parent_id, kind, block_key, block_type, position, data, meta, version)
    VALUES
      (${pageId}, ${sectionId}, 'column', NULL, 'column', ${position}, '{}', '{}', 0)
  `)) as unknown as [{ insertId: number | bigint }]
  return Number(res.insertId)
}

async function addSocialIconsToChannelsColumn(
  pageId: number,
  blocks: BlockRow[],
): Promise<{ inserted: boolean; reason?: string }> {
  // Idempotency — global check first. If any social_icons exists
  // anywhere on the contact page, we treat the additive step as
  // done. (The seed places it in the channels column, but an
  // operator could move it later.)
  const existing = blocks.find((b) => b.block_type === 'social_icons')
  if (existing) return { inserted: false, reason: 'already_present' }

  // Find a column whose children include a `lx_channel_card` widget
  // — that identifies the channels column unambiguously (no other
  // section on the seed uses lx_channel_card).
  const channelCard = blocks.find((b) => b.block_type === 'lx_channel_card')
  if (!channelCard || channelCard.parent_id == null) {
    return { inserted: false, reason: 'channels_column_not_found' }
  }
  const channelsColumnId = channelCard.parent_id

  // Compute the next position inside the channels column. Add 1000
  // past the max sibling position so the new widget sits at the
  // bottom — mirrors the seed's 1000-step rhythm.
  const siblings = blocks.filter((b) => b.parent_id === channelsColumnId)
  const maxPos = siblings.reduce((m, b) => Math.max(m, b.position), 0)
  const nextPos = maxPos + 1000

  await insertWidget(
    pageId,
    channelsColumnId,
    'social_icons',
    {
      items: [
        {
          platform: 'instagram',
          url: 'https://www.instagram.com/bestworldproperties',
        },
        {
          platform: 'facebook',
          url: 'https://www.facebook.com/yourcompany',
        },
        {
          platform: 'linkedin',
          url: 'https://www.linkedin.com/company/yourcompany',
        },
        {
          platform: 'whatsapp',
          url: 'https://wa.me/233242977639',
        },
      ],
      shape: 'circle',
      alignment: 'left',
      size: 'md',
    },
    nextPos,
    { marginTop: 'md' },
  )
  return { inserted: true }
}

async function addMapSection(
  pageId: number,
  blocks: BlockRow[],
): Promise<{ inserted: boolean; reason?: string }> {
  const existing = blocks.find((b) => b.block_type === 'lx_map')
  if (existing) return { inserted: false, reason: 'already_present' }

  // The new section sits between the Split Lead Capture (the section
  // whose subtree contains lx_channel_card) and the section after it.
  // Identify the Split section by its descendant block_type. Then pick
  // the position midpoint between it and the next sibling section so
  // we don't have to renumber any existing rows.
  const channelCard = blocks.find((b) => b.block_type === 'lx_channel_card')
  if (!channelCard || channelCard.parent_id == null) {
    return { inserted: false, reason: 'channels_column_not_found' }
  }
  const channelsColumn = blocks.find((b) => b.id === channelCard.parent_id)
  if (!channelsColumn || channelsColumn.parent_id == null) {
    return { inserted: false, reason: 'channels_column_parent_missing' }
  }
  const splitSectionId = channelsColumn.parent_id
  const splitSection = blocks.find((b) => b.id === splitSectionId)
  if (!splitSection || splitSection.kind !== 'section') {
    return { inserted: false, reason: 'split_section_not_found' }
  }

  const sections = blocks
    .filter((b) => b.kind === 'section')
    .sort((a, b) => a.position - b.position)
  const idx = sections.findIndex((s) => s.id === splitSectionId)
  const nextSection = sections[idx + 1]
  const newPos = nextSection
    ? Math.floor((splitSection.position + nextSection.position) / 2)
    : splitSection.position + 1000
  if (
    newPos === splitSection.position ||
    (nextSection && newPos === nextSection.position)
  ) {
    return { inserted: false, reason: 'no_position_slot' }
  }

  const sectionMeta = JSON.stringify({
    columns: 1,
    background: 'obsidian',
    padding: 'lg',
  })
  const newSectionId = await insertSection(pageId, sectionMeta, newPos)
  const newColumnId = await insertColumn(pageId, newSectionId, 1000)

  await insertWidget(
    pageId,
    newColumnId,
    'lx_eyebrow',
    {
      text: 'Visit us',
      prefix: 'none',
      tone: 'champagne',
      alignment: 'center',
      animation: 'fade-in',
    },
    1000,
    null,
  )
  await insertWidget(
    pageId,
    newColumnId,
    'lx_heading',
    {
      text: 'Where to find us.',
      level: 'h2',
      size: 'display-md',
      alignment: 'center',
      tone: 'ivory',
      italic: false,
      animation: 'none',
    },
    2000,
    { marginTop: 'xs' },
  )
  await insertWidget(
    pageId,
    newColumnId,
    'lx_map',
    {
      embedUrl: MAP_EMBED_URL,
      ratio: '16:9',
      caption: 'Nuumo Kofi Anum Link, Okpegon-Ledzokuku — Accra, Ghana',
      goldOverlay: false,
      animation: 'fade-in',
    },
    3000,
    { marginTop: 'md' },
  )
  return { inserted: true }
}

async function main() {
  const pageId = await getContactPageId()
  if (!pageId) {
    console.error('[add-contact-map-and-social] contact page not found')
    process.exit(1)
  }
  console.log(`[add-contact-map-and-social] contact page_id=${pageId}`)

  const blocks = await listLiveBlocks(pageId)

  const social = await addSocialIconsToChannelsColumn(pageId, blocks)
  if (social.inserted) {
    console.log('[add-contact-map-and-social] inserted social_icons widget')
  } else {
    console.log(
      `[add-contact-map-and-social] social_icons skipped (${social.reason})`,
    )
  }

  // Re-list blocks so the map step sees the social row if it was just
  // inserted (matters only when both steps run on the same fresh DB
  // — keeps the function inputs honest).
  const blocks2 = await listLiveBlocks(pageId)
  const mapResult = await addMapSection(pageId, blocks2)
  if (mapResult.inserted) {
    console.log(
      '[add-contact-map-and-social] inserted Visit-us map section + 3 widgets',
    )
  } else {
    console.log(
      `[add-contact-map-and-social] map section skipped (${mapResult.reason})`,
    )
  }

  await pool.end()
  process.exit(0)
}

void main().catch(async (e) => {
  console.error('[add-contact-map-and-social] error', e)
  try {
    await pool.end()
  } catch {}
  process.exit(1)
})

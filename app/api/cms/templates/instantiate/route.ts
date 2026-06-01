import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError, getRequestId } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkCmsMutationRate } from '@/lib/auth/cmsRateLimit'
import { parseAndSanitize } from '@/lib/cms/parse'
import { collectMediaPaths } from '@/lib/cms/mediaRefs'
import { assertMediaAvailable } from '@/lib/cms/mediaCheck'
import { blockSchemas } from '@/lib/cms/block-registry'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { tagsForBlockSave } from '@/lib/cache/tags'
import {
  ColumnMetaSchema,
  SectionMetaSchema,
  WidgetMetaSchema,
} from '@/lib/cms/blockMeta'
import {
  getTemplateById,
  findUnknownBlockType,
  countBlocks,
  MAX_INSTANTIATE_BLOCKS,
} from '@/lib/cms/sectionTemplates'

// Chunk J — POST /api/cms/templates/instantiate
//
// Recursively inserts a curated section template (server-side
// registered in lib/cms/sectionTemplates) into a page. Operator
// supplies ONLY the templateId — the payload is fully server-defined
// so a forged client can't smuggle arbitrary blocks through this
// endpoint.
//
// Body envelope:
//   {
//     pageId: number,           // target page; must exist + not in trash
//     templateId: string,       // must resolve via getTemplateById
//     afterBlockId?: number,    // optional anchor; new section lands
//                               // immediately after this top-level sibling.
//                               // When omitted, append to page tail.
//   }
//
// Auth + rate limiting mirror POST /api/cms/blocks (admin/editor; CSRF;
// per-user mutation bucket). A template can amplify to ~50 INSERTs
// internally (FAQ accordion + 8-tier templates being the largest); the
// mutation bucket consumes one slot per request — same trade-off as
// the duplicateBlock endpoint.
//
// Insertion order:
//   For each section in template.blocks:
//     1. INSERT section row (position = anchor + (i+1) * 1000)
//     2. For each column j in section.columns:
//          INSERT column row (parent_id = sectionId, position = (j+1)*1000)
//          For each widget k in column.widgets:
//            parseAndSanitize(widget.blockType, widget.data)
//            INSERT widget row (parent_id = columnId, position = (k+1)*1000)
//            wire media_references for any media_id in the payload
//
// Response (201):
//   {
//     rootBlockId: number,        // first section's new id — what the
//                                 // gallery's Undo button targets
//     createdBlockIds: number[],  // every new id, top-down (sections
//                                 // first, then columns, then widgets)
//   }
//
// Undo semantics: a single DELETE /api/cms/blocks/{rootBlockId}
// soft-deletes the root section; the existing DELETE recursive CTE
// cascade-soft-deletes every descendant. For multi-section templates,
// the controller fans out one DELETE per section root id (held in
// createdBlockIds).
//
// Audit: ONE audit row per instantiate gesture, capturing templateId
// + the full list of new ids so forensic replay can reconstruct the
// gesture without re-running the parser.

const PostBody = z
  .object({
    pageId: z.number().int().positive(),
    templateId: z.string().min(1).max(64),
    afterBlockId: z.number().int().positive().optional(),
  })
  .strict()

const ID_PATTERN = /^[a-z0-9-]+$/

interface InsertResult {
  insertId: number
}

interface SiblingRow {
  id: number
  position: number
}

export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'pages', 'write')
  checkCmsMutationRate(ctx)

  const body = PostBody.parse(await readJsonBody(req))
  if (!ID_PATTERN.test(body.templateId)) {
    throw new HttpError(400, 'invalid_template_id')
  }

  const template = getTemplateById(body.templateId)
  if (!template) throw new HttpError(404, 'unknown_template_id')

  // Pre-flight: every widget's blockType must be registered. A
  // template referencing an unregistered widget would 422 on the
  // parseAndSanitize call below, but the message would be the
  // generic "unknown_block_type" — surfacing it as a server-side
  // mis-registration is more useful than as a per-request 4xx.
  //
  // Generic error codes — no operator-provided templateId or internal
  // block-type taxonomy in the response (agent-review MEDIUM info-leak
  // finding). Detail is logged server-side via console.error so
  // operators can still grep server logs by templateId.
  const knownTypes = new Set(Object.keys(blockSchemas))
  const unknown = findUnknownBlockType(template, knownTypes)
  if (unknown !== null) {
    if (process.env.NODE_ENV !== 'production') {
      console.error(
        '[instantiate] template misconfigured:',
        body.templateId,
        'references unknown block_type:',
        unknown,
      )
    }
    throw new HttpError(500, 'template_misconfigured')
  }

  // Pre-flight: cap the per-request blast radius. A pathological
  // template with > MAX_INSTANTIATE_BLOCKS rows would consume too
  // many slot-buckets in the mutation rate-limiter for one gesture.
  const total = countBlocks(template)
  if (total > MAX_INSTANTIATE_BLOCKS) {
    if (process.env.NODE_ENV !== 'production') {
      console.error(
        '[instantiate] template exceeds block cap:',
        body.templateId,
        'blocks:',
        total,
        'cap:',
        MAX_INSTANTIATE_BLOCKS,
      )
    }
    throw new HttpError(500, 'template_block_cap')
  }

  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1')
  const userAgent = (headerObj['user-agent'] ?? '').slice(0, 255) || null
  const requestId = getRequestId(req)

  const txResult = await db.transaction(async (tx) => {
    // Lock the page row first (lock-order discipline — same as the
    // duplicate + reorder + create paths).
    const [pageRows] = (await tx.execute(sql`
      SELECT slug FROM pages
      WHERE id = ${body.pageId} AND deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [Array<{ slug: string }>]
    const pageSlug = pageRows[0]?.slug
    if (!pageSlug) throw new HttpError(404, 'page_not_found')

    // Compute the BASE position for the first inserted section. Two
    // paths:
    //   (a) afterBlockId provided — bisect with the next top-level
    //       sibling.
    //   (b) Append to tail (MAX(position) + 1000 for top-level rows).
    //
    // When the bisect gap can't fit (N+1) * 1000 of headroom, we fall
    // back to append-to-tail and SET positionFallback=true so the
    // client toast can explain "Inserted at bottom — couldn't fit at
    // requested position." (Agent review MEDIUM finding.)
    let basePos: number
    let positionFallback = false
    if (typeof body.afterBlockId === 'number') {
      const [siblings] = (await tx.execute(sql`
        SELECT id, position
        FROM content_blocks
        WHERE page_id = ${body.pageId}
          AND deleted_at IS NULL
          AND parent_id IS NULL
        ORDER BY position
      `)) as unknown as [SiblingRow[]]
      const idx = siblings.findIndex((r) => r.id === body.afterBlockId)
      if (idx >= 0 && idx < siblings.length - 1) {
        const gap = siblings[idx + 1]!.position - siblings[idx]!.position
        // Reserve at least template.blocks.length × 1000 of position
        // headroom. If the gap can't fit, append-to-tail (matches POST
        // /api/cms/blocks' position_gap_exhausted fall-through but
        // tolerated here because the operator's "after X" intent is
        // soft — they invoked a template gallery, not a precise
        // drag-drop).
        if (gap >= (template.blocks.length + 1) * 1000) {
          basePos = siblings[idx]!.position + 1000
        } else {
          // Bisect gap too small — fall through to tail. Surface the
          // signal so the client knows the requested position couldn't
          // be honoured.
          positionFallback = true
          const [maxRows] = (await tx.execute(sql`
            SELECT COALESCE(MAX(position), 0) AS maxPos
            FROM content_blocks
            WHERE page_id = ${body.pageId}
              AND deleted_at IS NULL
              AND parent_id IS NULL
          `)) as unknown as [Array<{ maxPos: number }>]
          basePos = Number(maxRows[0]?.maxPos ?? 0) + 1000
        }
      } else if (idx >= 0) {
        basePos = siblings[idx]!.position + 1000
      } else {
        // afterBlockId not found on this page — fall through to tail.
        // Signal the fallback so the client toast can explain it.
        positionFallback = true
        const [maxRows] = (await tx.execute(sql`
          SELECT COALESCE(MAX(position), 0) AS maxPos
          FROM content_blocks
          WHERE page_id = ${body.pageId}
            AND deleted_at IS NULL
            AND parent_id IS NULL
        `)) as unknown as [Array<{ maxPos: number }>]
        basePos = Number(maxRows[0]?.maxPos ?? 0) + 1000
      }
    } else {
      const [maxRows] = (await tx.execute(sql`
        SELECT COALESCE(MAX(position), 0) AS maxPos
        FROM content_blocks
        WHERE page_id = ${body.pageId}
          AND deleted_at IS NULL
          AND parent_id IS NULL
      `)) as unknown as [Array<{ maxPos: number }>]
      basePos = Number(maxRows[0]?.maxPos ?? 0) + 1000
    }

    const createdBlockIds: number[] = []
    const sectionRootIds: number[] = []

    for (const [sectionIdx, section] of template.blocks.entries()) {
      // Re-parse section meta defensively even though the round-trip
      // test pinned the registry. A future template author who skips
      // the test must still fail here, not at render time.
      const sectionMeta = SectionMetaSchema.parse(section.meta ?? {})
      const sectionPos = basePos + sectionIdx * 1000
      const [sectionInsert] = (await tx.execute(sql`
        INSERT INTO content_blocks
          (page_id, parent_id, kind, block_type, position, data, meta, version, updated_by)
        VALUES (
          ${body.pageId},
          NULL,
          'section',
          'section',
          ${sectionPos},
          '{}',
          ${JSON.stringify(sectionMeta)},
          0,
          ${ctx.userId}
        )
      `)) as unknown as [InsertResult]
      const sectionId = Number(sectionInsert.insertId)
      createdBlockIds.push(sectionId)
      sectionRootIds.push(sectionId)

      for (const [colIdx, col] of section.columns.entries()) {
        const colMeta = ColumnMetaSchema.parse(col.meta ?? {})
        const colPos = (colIdx + 1) * 1000
        const [colInsert] = (await tx.execute(sql`
          INSERT INTO content_blocks
            (page_id, parent_id, kind, block_type, position, data, meta, version, updated_by)
          VALUES (
            ${body.pageId},
            ${sectionId},
            'column',
            'column',
            ${colPos},
            '{}',
            ${JSON.stringify(colMeta)},
            0,
            ${ctx.userId}
          )
        `)) as unknown as [InsertResult]
        const colId = Number(colInsert.insertId)
        createdBlockIds.push(colId)

        for (const [wIdx, w] of col.widgets.entries()) {
          // Defence-in-depth: re-validate the widget payload through
          // parseAndSanitize even though the round-trip test pinned
          // it. A future template author who skips the test must
          // still 500 here, not at render time.
          const parsedData = parseAndSanitize(w.blockType, w.data)
          const widgetMetaJson =
            w.meta !== undefined
              ? JSON.stringify(WidgetMetaSchema.parse(w.meta))
              : null
          const wPos = (wIdx + 1) * 1000
          const [wInsert] = (await tx.execute(sql`
            INSERT INTO content_blocks
              (page_id, parent_id, kind, block_type, position, data, meta, version, updated_by)
            VALUES (
              ${body.pageId},
              ${colId},
              'widget',
              ${w.blockType},
              ${wPos},
              ${JSON.stringify(parsedData)},
              ${widgetMetaJson},
              0,
              ${ctx.userId}
            )
          `)) as unknown as [InsertResult]
          const wId = Number(wInsert.insertId)
          createdBlockIds.push(wId)

          // Wire media_references for any media_id in the payload.
          const refs = collectMediaPaths(parsedData)
          if (refs.length > 0) {
            const mediaIds = [...new Set(refs.map((r) => r.mediaId))]
            await assertMediaAvailable(tx, mediaIds)
            for (const r of refs) {
              await tx.execute(sql`
                INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
                VALUES (${r.mediaId}, 'content_block', ${wId}, ${r.field})
              `)
            }
          }
        }
      }
    }

    // Audit. ONE row per instantiate gesture, scoped to the FIRST
    // section root id so forensic queries filtering
    // `resourceType = 'content_block'` AND `resourceId = <root>`
    // surface this gesture alongside other block-mutating actions
    // (delta-review LOW finding — earlier draft used resourceType:
    // 'page' which broke the standard filter). The diff payload's
    // section_root_ids + created_block_ids preserve the full gesture
    // reconstruction so multi-section templates remain queryable.
    const auditResourceId =
      sectionRootIds[0] !== undefined
        ? String(sectionRootIds[0])
        : String(body.pageId)
    await tx.insert(auditLog).values({
      userId: ctx.userId,
      action: 'create',
      resourceType: 'content_block',
      resourceId: auditResourceId,
      diff: {
        kind: AUDIT_KIND.instantiateTemplate,
        template_id: body.templateId,
        page_id: body.pageId,
        created_block_ids: createdBlockIds,
        section_root_ids: sectionRootIds,
        block_count: createdBlockIds.length,
      } as unknown as object,
      ip,
      userAgent,
      requestId,
    })

    const tags = tagsForBlockSave(pageSlug).tags
    const queueRowId = await enqueueRevalidate(tx, tags)
    return {
      createdBlockIds,
      sectionRootIds,
      queueRowId,
      tags,
      positionFallback,
    }
  })

  queueMicrotask(() => {
    void drainRevalidate(txResult.queueRowId, txResult.tags)
  })

  const rootBlockId = txResult.sectionRootIds[0]
  if (rootBlockId === undefined) {
    // Reachable only when template.blocks is empty — the round-trip
    // test pins length > 0 but defence-in-depth keeps the response
    // well-typed.
    throw new HttpError(500, 'template_empty')
  }

  return new Response(
    JSON.stringify({
      rootBlockId,
      createdBlockIds: txResult.createdBlockIds,
      sectionRootIds: txResult.sectionRootIds,
      positionFallback: txResult.positionFallback,
    }),
    {
      status: 201,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    },
  )
})


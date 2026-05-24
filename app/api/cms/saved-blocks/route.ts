import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError, getRequestId } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate, checkReadRate } from '@/lib/auth/cmsRateLimit'
import { parseAndSanitize } from '@/lib/cms/parse'
import { blockSchemas } from '@/lib/cms/block-registry'
import { WidgetMetaSchema } from '@/lib/cms/blockMeta'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import {
  SAVED_BLOCKS_LIST_LIMIT,
  SavedBlockCreateBody,
  SavedBlockNameSchema,
  type SavedBlockListItem,
} from '@/lib/cms/savedBlocks'

// GET /api/cms/saved-blocks
// List the calling operator's saved-block library, newest first. Hard-
// capped at SAVED_BLOCKS_LIST_LIMIT (200) so an operator who racks up
// thousands of saved blocks can't blow up the panel's DOM. The panel
// itself surfaces a banner when the cap is hit; the server still returns
// the freshest 200 so the operator can prune from the panel.
//
// Returns ONLY identity metadata (id/name/blockType/timestamps) — NOT
// the data/meta payload. Operators fetch the full row on click via
// GET /[id]. Keeps the panel-load roundtrip small and prevents leaking
// widget payloads through a survey-style enumeration.
export const GET = withError(async () => {
  const ctx = await requireRole(['admin', 'editor'])
  // Read-rate-limited so a forged session token can't enumerate the
  // library at full bandwidth. checkReadRate is the same bucket used
  // by other CMS read endpoints — appropriate for an auth'd list call.
  checkReadRate(ctx.userId)

  const [rows] = (await db.execute(sql`
    SELECT id, name, block_type AS blockType, created_at AS createdAt, updated_at AS updatedAt
    FROM saved_blocks
    WHERE user_id = ${ctx.userId}
    ORDER BY created_at DESC, id DESC
    LIMIT ${SAVED_BLOCKS_LIST_LIMIT}
  `)) as unknown as [
    Array<{
      id: number
      name: string
      blockType: string
      createdAt: Date | string
      updatedAt: Date | string
    }>,
  ]

  const items: SavedBlockListItem[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    blockType: r.blockType,
    createdAt:
      r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    updatedAt:
      r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
  }))

  return new Response(
    JSON.stringify({ items, limit: SAVED_BLOCKS_LIST_LIMIT }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    },
  )
})

// POST /api/cms/saved-blocks
// Add a widget to the operator's library. blockType must be a registered
// widget (parsed via blockSchemas — fails 400 unknown_block_type
// otherwise). `data` re-runs through parseAndSanitize so any rich-text
// fields are DOMPurify'd at the SAVE boundary too — defence in depth
// against a tampered client that POSTs raw HTML straight here.
// `meta` is gated by WidgetMetaSchema (.strict()) and the htmlId field
// is dropped BEFORE persistence (saved blocks are per-page-orphaned and
// cannot carry a per-page-unique anchor id forward).
export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const body = SavedBlockCreateBody.parse(await readJsonBody(req))

  // Name validation — sanitise + length cap. SavedBlockNameSchema runs
  // the same sanitisation as LabelSchema (control bytes stripped, whitespace
  // collapsed). The Zod refinement gives a descriptive 400 on empty-
  // after-sanitise inputs vs a generic invalid_request.
  const nameParsed = SavedBlockNameSchema.safeParse(body.name)
  if (!nameParsed.success) {
    throw new HttpError(400, 'invalid_name')
  }
  const name = nameParsed.data

  // blockType must be registered. Same gate as POST /api/cms/blocks.
  if (!(body.blockType in blockSchemas)) {
    throw new HttpError(400, 'unknown_block_type')
  }

  // Re-validate data via the registry's Zod schema. Throws ZodError on
  // failure → withError → 400 invalid_request. Sanitises rich-text
  // fields in-place (sanitizeRichText / DOMPurify) before the write
  // — saved blocks must never persist un-sanitised HTML.
  const parsedData = parseAndSanitize(body.blockType, body.data)

  // Widget meta — strip htmlId BEFORE WidgetMetaSchema runs so a payload
  // carrying { htmlId: 'hero-2' } passes (the field is dropped, not
  // rejected). Saved blocks are page-orphaned by definition; the anchor
  // id is re-assigned at instantiate time if the operator wants one.
  let metaJson: string | null = null
  if (body.meta !== undefined && body.meta !== null) {
    if (typeof body.meta !== 'object' || Array.isArray(body.meta)) {
      throw new HttpError(400, 'invalid_meta')
    }
    const metaInput = { ...(body.meta as Record<string, unknown>) }
    delete metaInput['htmlId']
    const parsedMeta = WidgetMetaSchema.parse(metaInput)
    // Empty meta object → store NULL (matches POST /api/cms/blocks's
    // "no overrides" canonical representation).
    if (Object.keys(parsedMeta).length > 0) {
      metaJson = JSON.stringify(parsedMeta)
    }
  }

  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1')
  const userAgent = (headerObj['user-agent'] ?? '').slice(0, 255) || null
  const requestId = getRequestId(req)

  const created = await db.transaction(async (tx) => {
    const [insertResult] = (await tx.execute(sql`
      INSERT INTO saved_blocks (user_id, name, kind, block_type, data, meta)
      VALUES (
        ${ctx.userId},
        ${name},
        'widget',
        ${body.blockType},
        ${JSON.stringify(parsedData)},
        ${metaJson}
      )
    `)) as unknown as [{ insertId: number }]
    const id = Number(insertResult.insertId)

    await tx.insert(auditLog).values({
      userId: ctx.userId,
      action: 'create',
      resourceType: 'saved_block',
      resourceId: String(id),
      diff: {
        kind: AUDIT_KIND.savedBlockCreate,
        block_type: body.blockType,
        name,
      },
      ip,
      userAgent,
      requestId,
    })

    return { id }
  })

  // Read createdAt back so the client doesn't have to optimistically
  // synthesize it (and so the panel's relative-time renderer works
  // immediately without waiting for a list refetch).
  const [createdRows] = (await db.execute(sql`
    SELECT created_at AS createdAt FROM saved_blocks WHERE id = ${created.id}
  `)) as unknown as [Array<{ createdAt: Date | string }>]
  const createdAtRaw = createdRows[0]?.createdAt
  const createdAt =
    createdAtRaw instanceof Date
      ? createdAtRaw.toISOString()
      : typeof createdAtRaw === 'string'
        ? createdAtRaw
        : new Date().toISOString()

  return new Response(
    JSON.stringify({
      id: created.id,
      name,
      blockType: body.blockType,
      createdAt,
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

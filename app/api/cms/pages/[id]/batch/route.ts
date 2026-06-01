import { createHash } from 'node:crypto'
import diff from 'microdiff'
import { z, ZodError } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError, getRequestId } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { isDuplicateKey } from '@/lib/db/errors'
import { parseAndSanitize } from '@/lib/cms/parse'
import { collectMediaPaths } from '@/lib/cms/mediaRefs'
import { assertMediaAvailable } from '@/lib/cms/mediaCheck'
import { blockSchemas, FIXED_BLOCK_KEYS_PER_PAGE } from '@/lib/cms/block-registry'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import { AUDIT_DIFF_CAP, capAuditDiff, type DiffOp } from '@/lib/cms/saveBlock'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { tagsForBlockSave } from '@/lib/cache/tags'
import {
  SectionMetaSchema,
  ColumnMetaSchema,
  WidgetMetaSchema,
  DEFAULT_SECTION_META,
  MAX_SECTION_COLUMNS,
  type BlockKind,
} from '@/lib/cms/blockMeta'

// ─────────────────────────────────────────────────────────────────────
// POST /api/cms/pages/[id]/batch — the AGENT FAST-LANE.
//
// Why this endpoint exists. Editing a page through the per-block PATCH
// surface is structurally serial: every block write bumps the SHARED
// `pages.version` (saveBlock.ts), so a client editing N blocks must (1)
// GET the whole tree for ids + versions + current meta, then (2) fire N
// PATCHes STRICTLY in sequence — each needs the new `pageVersion` the
// previous returned — and meta is a full replace, forcing a read-modify-
// write per section. For an AI agent scripting "recolor 12 sections +
// retitle 5 headings" that is one GET plus 17 serial round-trips, each
// re-authing + a locked TX. Direct SQL does it in one multi-row UPDATE.
//
// This endpoint closes that gap WITHOUT abandoning the safety the API
// adds over raw SQL. Many ops travel in ONE request → ONE transaction →
// ONE `pages.version` bump → ONE coalesced revalidate. Optimistic-lock
// versions are OPTIONAL (omit = last-write-wins, exactly like a direct
// UPDATE; provide `pageVersion` / per-op `expectedVersion` = the same
// dual-axis lock the dashboard uses). Partial-merge ops (`dataPatch` /
// `metaPatch`) let an agent change one field without reading the current
// value first. Every per-op apply still runs the FULL write boundary:
// Zod + DOMPurify (parseAndSanitize), container-meta schema validation,
// per-page htmlId uniqueness, media-reference availability + diff, the
// column-count cap, the fixed-slot reservation, and a per-op audit row.
//
// Reachable by bearer API tokens (path starts with /api/cms/ →
// tokenAllowedPath) AND by the session-cookie dashboard. CSRF is enforced
// for cookie callers and skipped for bearer tokens (requireCsrf honours
// the apitoken: jti contract). Roles: admin + editor, matching every
// per-block content route.
// ─────────────────────────────────────────────────────────────────────

const ID_PATTERN = /^[1-9][0-9]{0,9}$/
function parseId(raw: string): number {
  if (!ID_PATTERN.test(raw)) throw new HttpError(400, 'invalid_id')
  return Number(raw)
}

// Bounds. The whole batch runs in ONE transaction holding the page row
// FOR UPDATE, and each op issues several sequential DB round-trips, so the
// page-write lock is held for roughly (ops × round-trips). MAX_OPS caps
// that locked window — at 50 the worst case is a few hundred round-trips
// (sub-second on a healthy DB), which still collapses an agent's typical
// "edit 17 blocks" workload into a single request while bounding how long
// concurrent same-page writers (other agents / the dashboard) can stall.
// An agent building a large page issues a handful of batches, each one
// round-trip. readJsonBody already caps the envelope at 256 KB.
// orderedBlockIds gets a larger ceiling because a single reorder of a wide
// page is one op but lists every sibling.
const MAX_OPS = 50
const MAX_ORDERED_IDS = 500
// Temp-id refs (forward references between create ops in the same batch)
// are opaque client tokens — constrained to a safe charset/length so they
// can't smuggle anything into an error string or map key.
const TEMP_REF_RE = /^[A-Za-z0-9_-]{1,64}$/

// A create op's parent: an existing block id, an explicit top-level null,
// or `{ ref }` pointing at a block CREATED earlier in THIS batch.
const TempRef = z.object({ ref: z.string().regex(TEMP_REF_RE) }).strict()
const ParentTarget = z.union([
  z.number().int().positive(),
  z.null(),
  TempRef,
])

const CreateOp = z
  .object({
    op: z.literal('create'),
    // Optional handle so later ops in the same batch can reference this
    // freshly-created row before it has a real id (parent wiring, etc.).
    tempId: z.string().regex(TEMP_REF_RE).optional(),
    kind: z.enum(['section', 'column', 'widget']),
    blockType: z.string().min(1).max(50).optional(),
    parent: ParentTarget.optional(),
    data: z.unknown().optional(),
    meta: z.unknown().optional(),
  })
  .strict()

const PatchDataOp = z
  .object({
    op: z.literal('patchData'),
    blockId: z.number().int().positive(),
    // Opt-in optimistic lock. Omit → last-write-wins on current version.
    expectedVersion: z.number().int().nonnegative().optional(),
    // Exactly one of: full replace (`data`) or shallow top-level merge
    // (`dataPatch`). The handler 400s if both or neither are present.
    data: z.unknown().optional(),
    dataPatch: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const PatchMetaOp = z
  .object({
    op: z.literal('patchMeta'),
    blockId: z.number().int().positive(),
    expectedVersion: z.number().int().nonnegative().optional(),
    meta: z.unknown().optional(),
    metaPatch: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const DeleteOp = z
  .object({
    op: z.literal('delete'),
    blockId: z.number().int().positive(),
    expectedVersion: z.number().int().nonnegative().optional(),
  })
  .strict()

const ReorderOp = z
  .object({
    op: z.literal('reorderChildren'),
    parent: ParentTarget.optional(),
    // The COMPLETE living-child set of `parent`, in the desired order.
    // Partial lists are rejected (incomplete_reorder) so a reorder can
    // never silently strand a sibling at a stale position.
    orderedBlockIds: z
      .array(z.number().int().positive())
      .min(1)
      .max(MAX_ORDERED_IDS),
  })
  .strict()

const BatchOp = z.discriminatedUnion('op', [
  CreateOp,
  PatchDataOp,
  PatchMetaOp,
  DeleteOp,
  ReorderOp,
])

const BatchBody = z
  .object({
    // Whole-batch optimistic lock. Omit → last-write-wins.
    pageVersion: z.number().int().nonnegative().optional(),
    ops: z.array(BatchOp).min(1).max(MAX_OPS),
  })
  .strict()

type RouteCtx = { params: Promise<{ id: string }> }

// Read htmlId out of a parsed meta object (mirrors the per-block routes).
function extractHtmlId(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined
  const v = (meta as { htmlId?: unknown }).htmlId
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

// Coerce a stored JSON column (string | null) to a plain object for
// merge bases / audit diffs. A corrupt blob degrades to {} rather than
// crashing the whole batch with a SyntaxError.
function asObject(raw: string | null): Record<string, unknown> {
  if (raw === null) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

// Per-op error → `op[<i>]:<code>` so the agent knows EXACTLY which op of
// a 50-op batch failed (the whole TX rolls back; nothing partially lands).
function opErr(index: number, status: number, code: string): HttpError {
  return new HttpError(status, `op[${index}]:${code}`)
}

interface CreateRow {
  id: number
  kind: BlockKind
  page_id: number
}

export const POST = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const pageId = parseId(rawId)

  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })

  const body = BatchBody.parse(await readJsonBody(req))

  // Charge the mutation limiter ONE tick PER OP — parity with the per-block
  // routes (which each pay one tick per single mutation). Charging per op
  // (not per request) closes the amplification gap where one 50-op batch
  // would otherwise cost the same budget as a single PATCH, letting a
  // token evade the limiter by fanning mutations out through batches. The
  // charge happens before any DB work, so an over-limit batch 429s without
  // touching the page.
  for (let i = 0; i < body.ops.length; i += 1) checkMutationRate(ctx.userId)

  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1')
  const userAgent = (headerObj['user-agent'] ?? '').slice(0, 255) || null
  const requestId = getRequestId(req)

  const txResult = await db.transaction(async (tx) => {
    // 1. Lock the page row FIRST (deadlock pre-emption — same lock order
    //    as saveBlock: pages → content_blocks). One optional whole-batch
    //    optimistic-lock check, then we bump pages.version exactly ONCE
    //    at the end for the entire batch.
    const [pageRows] = (await tx.execute(sql`
      SELECT id, slug, version FROM pages
      WHERE id = ${pageId} AND deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [Array<{ id: number; slug: string; version: number }>]
    const pageRow = pageRows[0]
    if (!pageRow) throw new HttpError(404, 'page_not_found')
    if (body.pageVersion !== undefined && pageRow.version !== body.pageVersion) {
      throw new HttpError(409, 'stale_page_version')
    }
    const pageSlug = pageRow.slug

    const tempIdMap = new Map<string, number>()
    const tags = new Set<string>()
    // Lazy append cursor per parent bucket. Keyed 'null' for top-level.
    // Seeded from the live MAX(position); incremented in-memory as we
    // INSERT so multiple creates under one parent land in order. There is
    // NO unique index on (parent_id, position) — ties break by id and a
    // gap from a deleted row is harmless, so append-only is collision-safe.
    const posCursor = new Map<string, number>()
    const results: Array<Record<string, unknown>> = []

    const resolveParent = (
      target: number | null | { ref: string } | undefined,
      index: number,
    ): number | null => {
      if (target === undefined || target === null) return null
      if (typeof target === 'number') return target
      const resolved = tempIdMap.get(target.ref)
      if (resolved === undefined) throw opErr(index, 400, 'unknown_parent_ref')
      return resolved
    }

    const nextPosition = async (parentId: number | null): Promise<number> => {
      const key = parentId === null ? 'null' : String(parentId)
      if (!posCursor.has(key)) {
        const [maxRows] = (await tx.execute(sql`
          SELECT COALESCE(MAX(position), 0) AS maxPos FROM content_blocks
          WHERE page_id = ${pageId} AND deleted_at IS NULL
            AND parent_id ${parentId === null ? sql`IS NULL` : sql`= ${parentId}`}
        `)) as unknown as [Array<{ maxPos: number }>]
        posCursor.set(key, Number(maxRows[0]?.maxPos ?? 0))
      }
      const next = posCursor.get(key)! + 1000
      posCursor.set(key, next)
      return next
    }

    // Per-page htmlId uniqueness. The DB unique index on the generated
    // html_id_live column (migration 0014) is the authoritative backstop;
    // this app-level check (which sees this batch's own uncommitted rows)
    // turns a would-be unique-violation into a clean op-scoped 409.
    const assertHtmlIdFree = async (
      htmlId: string,
      selfId: number | null,
      index: number,
    ): Promise<void> => {
      const [rows] = (await tx.execute(
        selfId === null
          ? sql`SELECT id FROM content_blocks
              WHERE page_id = ${pageId} AND deleted_at IS NULL
                AND html_id_live = ${htmlId}
              LIMIT 1`
          : sql`SELECT id FROM content_blocks
              WHERE page_id = ${pageId} AND deleted_at IS NULL
                AND id <> ${selfId}
                AND html_id_live = ${htmlId}
              LIMIT 1`,
      )) as unknown as [Array<{ id: number }>]
      if (rows.length > 0) throw opErr(index, 409, 'html_id_collision')
    }

    const audit = async (
      action: 'create' | 'update' | 'delete' | 'reorder',
      resourceType: 'content_block' | 'page',
      resourceId: string,
      auditDiff: object,
    ): Promise<void> => {
      await tx.insert(auditLog).values({
        userId: ctx.userId,
        tokenId: ctx.tokenId,
        action,
        resourceType,
        resourceId,
        diff: auditDiff as unknown as object,
        ip,
        userAgent,
        requestId,
      })
    }

    // 2. Apply ops IN ORDER. Sequential so temp-id forward refs resolve
    //    and so each op sees the prior ops' uncommitted writes (htmlId
    //    collisions, column counts, positions all stay correct mid-batch).
    const applyOp = async (
      i: number,
      op: (typeof body.ops)[number],
    ): Promise<void> => {
      if (op.op === 'create') {
        const kind = op.kind
        const parentId = resolveParent(op.parent, i)

        if (kind === 'section' && parentId !== null) {
          throw opErr(i, 400, 'section_parent_must_be_null')
        }
        if (kind === 'column' && parentId === null) {
          throw opErr(i, 400, 'column_parent_required')
        }

        if (parentId !== null) {
          const [parentRows] = (await tx.execute(sql`
            SELECT id, kind, page_id FROM content_blocks
            WHERE id = ${parentId} AND deleted_at IS NULL
            FOR UPDATE
          `)) as unknown as [CreateRow[]]
          const parent = parentRows[0]
          if (!parent || parent.page_id !== pageId) {
            throw opErr(i, 404, 'parent_not_found')
          }
          if (kind === 'column' && parent.kind !== 'section') {
            throw opErr(i, 400, 'column_parent_must_be_section')
          }
          if (kind === 'widget' && parent.kind !== 'column') {
            throw opErr(i, 400, 'widget_parent_must_be_column')
          }
          if (kind === 'column') {
            const [cc] = (await tx.execute(sql`
              SELECT COUNT(*) AS n FROM content_blocks
              WHERE parent_id = ${parentId} AND deleted_at IS NULL
            `)) as unknown as [Array<{ n: number | bigint }>]
            if (Number(cc[0]?.n ?? 0) >= MAX_SECTION_COLUMNS) {
              throw opErr(i, 409, 'column_count_exceeded')
            }
          }
        }

        let insertBlockType: string
        let insertData: string
        let insertMeta: string | null
        let parsedWidgetData: unknown = null
        try {
          if (kind === 'widget') {
            if (!op.blockType) throw opErr(i, 400, 'missing_block_type')
            if (!(op.blockType in blockSchemas)) {
              throw opErr(i, 400, 'unknown_block_type')
            }
            if (op.data === undefined) throw opErr(i, 400, 'missing_data')
            const fixed = FIXED_BLOCK_KEYS_PER_PAGE[pageSlug] ?? []
            if ((fixed as readonly string[]).includes(op.blockType)) {
              throw opErr(i, 409, 'block_type_reserved_for_fixed_slot')
            }
            parsedWidgetData = parseAndSanitize(op.blockType, op.data)
            insertBlockType = op.blockType
            insertData = JSON.stringify(parsedWidgetData)
            if (op.meta !== undefined && op.meta !== null) {
              const m = WidgetMetaSchema.parse(op.meta)
              insertMeta =
                Object.keys(m).length > 0 ? JSON.stringify(m) : null
            } else {
              insertMeta = null
            }
          } else {
            insertBlockType = kind
            insertData = '{}'
            const provided =
              op.meta && typeof op.meta === 'object' && !Array.isArray(op.meta)
                ? (op.meta as Record<string, unknown>)
                : {}
            if (kind === 'section') {
              // Section meta requires columns/background/padding. Seed the
              // defaults so an agent can create a section with partial (or
              // no) meta; provided keys override.
              const m = SectionMetaSchema.parse({
                ...DEFAULT_SECTION_META,
                ...provided,
              })
              insertMeta = JSON.stringify(m)
            } else {
              const m = ColumnMetaSchema.parse(provided)
              insertMeta = JSON.stringify(m)
            }
          }
        } catch (e) {
          if (e instanceof HttpError) throw e
          if (e instanceof ZodError) throw opErr(i, 400, 'invalid_data')
          throw e
        }

        const htmlId = extractHtmlId(asObject(insertMeta))
        if (htmlId) await assertHtmlIdFree(htmlId, null, i)

        const position = await nextPosition(parentId)
        const [ins] = (await tx.execute(sql`
          INSERT INTO content_blocks
            (page_id, parent_id, kind, block_type, position, data, meta, version, updated_by)
          VALUES (
            ${pageId}, ${parentId}, ${kind}, ${insertBlockType},
            ${position}, ${insertData}, ${insertMeta}, 0, ${ctx.userId}
          )
        `)) as unknown as [{ insertId: number }]
        const newId = Number(ins.insertId)

        if (kind === 'widget') {
          const refs = collectMediaPaths(parsedWidgetData)
          const mediaIds = [...new Set(refs.map((r) => r.mediaId))]
          await assertMediaAvailable(tx, mediaIds)
          for (const r of refs) {
            await tx.execute(sql`
              INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
              VALUES (${r.mediaId}, 'content_block', ${newId}, ${r.field})
            `)
          }
        }

        const createPayload =
          kind === 'widget'
            ? { kind: AUDIT_KIND.create, data: parsedWidgetData }
            : {
                kind: AUDIT_KIND.create,
                container_kind: kind,
                parent_id: parentId,
                meta: insertMeta === null ? null : JSON.parse(insertMeta),
              }
        const serializedLen = JSON.stringify(createPayload).length
        await audit(
          'create',
          'content_block',
          String(newId),
          serializedLen > AUDIT_DIFF_CAP
            ? { kind: AUDIT_KIND.createTruncated, byteSize: serializedLen }
            : createPayload,
        )

        if (op.tempId) {
          if (tempIdMap.has(op.tempId)) throw opErr(i, 400, 'duplicate_temp_id')
          tempIdMap.set(op.tempId, newId)
        }
        for (const t of tagsForBlockSave(
          pageSlug,
          kind === 'widget' ? insertBlockType : undefined,
        ).tags) {
          tags.add(t)
        }
        results.push({
          op: 'create',
          tempId: op.tempId ?? null,
          id: newId,
          version: 0,
          parentId,
          position,
        })
      } else if (op.op === 'patchData') {
        const hasFull = op.data !== undefined
        const hasPatch = op.dataPatch !== undefined
        if (hasFull === hasPatch) {
          throw opErr(i, 400, 'exactly_one_of_data_or_data_patch')
        }
        const [rows] = (await tx.execute(sql`
          SELECT id, kind, block_type, data, version FROM content_blocks
          WHERE id = ${op.blockId} AND page_id = ${pageId} AND deleted_at IS NULL
          FOR UPDATE
        `)) as unknown as [
          Array<{
            id: number
            kind: BlockKind
            block_type: string
            data: string
            version: number
          }>,
        ]
        const row = rows[0]
        if (!row) throw opErr(i, 404, 'not_found')
        if (row.kind !== 'widget') throw opErr(i, 400, 'wrong_field_for_kind')
        if (
          op.expectedVersion !== undefined &&
          row.version !== op.expectedVersion
        ) {
          throw opErr(i, 409, 'stale_block_version')
        }

        const oldData = asObject(row.data)
        const candidate = hasFull
          ? op.data
          : { ...oldData, ...(op.dataPatch as Record<string, unknown>) }
        let parsed: unknown
        try {
          parsed = parseAndSanitize(row.block_type, candidate)
        } catch (e) {
          if (e instanceof ZodError) throw opErr(i, 400, 'invalid_data')
          throw e
        }
        const parsedJson = JSON.stringify(parsed)
        const newVersion = row.version + 1
        await tx.execute(sql`
          UPDATE content_blocks
          SET data = ${parsedJson}, version = ${newVersion}, updated_by = ${ctx.userId}
          WHERE id = ${op.blockId}
        `)

        // Media-reference diff (identical contract to saveBlock).
        const oldRefs = collectMediaPaths(oldData)
        const newRefs = collectMediaPaths(parsed)
        const oldSet = new Set(oldRefs.map((r) => `${r.mediaId}::${r.field}`))
        const newSet = new Set(newRefs.map((r) => `${r.mediaId}::${r.field}`))
        const newMediaIds = [
          ...new Set(
            newRefs
              .filter((r) => !oldSet.has(`${r.mediaId}::${r.field}`))
              .map((r) => r.mediaId),
          ),
        ]
        await assertMediaAvailable(tx, newMediaIds)
        for (const r of oldRefs) {
          if (!newSet.has(`${r.mediaId}::${r.field}`)) {
            await tx.execute(sql`
              DELETE FROM media_references
              WHERE media_id = ${r.mediaId} AND referent_type = 'content_block'
                AND referent_id = ${op.blockId} AND field = ${r.field}
            `)
          }
        }
        for (const r of newRefs) {
          if (!oldSet.has(`${r.mediaId}::${r.field}`)) {
            await tx.execute(sql`
              INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
              VALUES (${r.mediaId}, 'content_block', ${op.blockId}, ${r.field})
            `)
          }
        }

        const patch = diff(oldData, (parsed as object) ?? {}) as DiffOp[]
        const cappedDiff = capAuditDiff(patch)
        await audit(
          'update',
          'content_block',
          String(op.blockId),
          Array.isArray(cappedDiff)
            ? { kind: AUDIT_KIND.patch, ops: cappedDiff }
            : { ...(cappedDiff as object), kind: AUDIT_KIND.patchTruncated },
        )
        for (const t of tagsForBlockSave(pageSlug, row.block_type).tags) {
          tags.add(t)
        }
        results.push({ op: 'patchData', id: op.blockId, version: newVersion })
      } else if (op.op === 'patchMeta') {
        const hasFull = op.meta !== undefined
        const hasPatch = op.metaPatch !== undefined
        if (hasFull === hasPatch) {
          throw opErr(i, 400, 'exactly_one_of_meta_or_meta_patch')
        }
        const [rows] = (await tx.execute(sql`
          SELECT id, kind, block_type, meta, version FROM content_blocks
          WHERE id = ${op.blockId} AND page_id = ${pageId} AND deleted_at IS NULL
          FOR UPDATE
        `)) as unknown as [
          Array<{
            id: number
            kind: BlockKind
            block_type: string
            meta: string | null
            version: number
          }>,
        ]
        const row = rows[0]
        if (!row) throw opErr(i, 404, 'not_found')
        if (
          op.expectedVersion !== undefined &&
          row.version !== op.expectedVersion
        ) {
          throw opErr(i, 409, 'stale_block_version')
        }

        const oldMeta = asObject(row.meta)
        const patchObj = (op.metaPatch ?? {}) as Record<string, unknown>
        let parsedMeta: unknown
        try {
          if (row.kind === 'section') {
            const candidate = hasFull
              ? op.meta
              : { ...DEFAULT_SECTION_META, ...oldMeta, ...patchObj }
            parsedMeta = SectionMetaSchema.parse(candidate)
          } else if (row.kind === 'column') {
            const candidate = hasFull ? op.meta : { ...oldMeta, ...patchObj }
            parsedMeta = ColumnMetaSchema.parse(candidate)
          } else {
            const candidate = hasFull ? op.meta : { ...oldMeta, ...patchObj }
            parsedMeta = WidgetMetaSchema.parse(candidate)
          }
        } catch (e) {
          if (e instanceof ZodError) throw opErr(i, 400, 'invalid_meta')
          throw e
        }
        const metaJson = JSON.stringify(parsedMeta)
        const htmlId = extractHtmlId(parsedMeta)
        if (htmlId) await assertHtmlIdFree(htmlId, op.blockId, i)

        const newVersion = row.version + 1
        await tx.execute(sql`
          UPDATE content_blocks
          SET meta = ${metaJson}, version = ${newVersion}, updated_by = ${ctx.userId}
          WHERE id = ${op.blockId}
        `)
        // Section/column/widget meta is small (< 1 KB even at maximum), so
        // the before/after pair always fits well under AUDIT_DIFF_CAP — no
        // truncation branch needed (matches saveBlockMeta). A future
        // meta-schema change that adds a large field must revisit this.
        await audit('update', 'content_block', String(op.blockId), {
          kind: AUDIT_KIND.patch,
          container_kind: row.kind,
          before: row.meta === null ? null : oldMeta,
          after: parsedMeta,
        })
        for (const t of tagsForBlockSave(pageSlug, row.block_type).tags) {
          tags.add(t)
        }
        results.push({ op: 'patchMeta', id: op.blockId, version: newVersion })
      } else if (op.op === 'delete') {
        const [rows] = (await tx.execute(sql`
          SELECT block_key, kind, block_type, data, version FROM content_blocks
          WHERE id = ${op.blockId} AND page_id = ${pageId} AND deleted_at IS NULL
          FOR UPDATE
        `)) as unknown as [
          Array<{
            block_key: string | null
            kind: BlockKind
            block_type: string
            data: string
            version: number
          }>,
        ]
        const row = rows[0]
        if (!row) throw opErr(i, 404, 'not_found')
        if (row.block_key !== null) {
          throw opErr(i, 409, 'cannot_delete_fixed_block')
        }
        if (
          op.expectedVersion !== undefined &&
          row.version !== op.expectedVersion
        ) {
          throw opErr(i, 409, 'stale_block_version')
        }

        let deletedIds: number[]
        if (row.kind === 'widget') {
          deletedIds = [op.blockId]
        } else {
          const [descRows] = (await tx.execute(sql`
            WITH RECURSIVE descendants AS (
              SELECT id, page_id FROM content_blocks
              WHERE id = ${op.blockId} AND deleted_at IS NULL
              UNION ALL
              SELECT cb.id, cb.page_id FROM content_blocks cb
              INNER JOIN descendants d ON cb.parent_id = d.id
              WHERE cb.deleted_at IS NULL AND cb.page_id = d.page_id
            )
            SELECT id FROM descendants
          `)) as unknown as [Array<{ id: number }>]
          deletedIds = descRows.map((r) => r.id)
          if (deletedIds.length === 0) deletedIds = [op.blockId]
        }
        await tx.execute(sql`
          UPDATE content_blocks
          SET deleted_at = NOW(3), version = version + 1, updated_by = ${ctx.userId}
          WHERE deleted_at IS NULL AND id IN (${sql.join(deletedIds, sql.raw(','))})
        `)
        if (row.kind === 'widget') {
          await tx.execute(sql`
            DELETE FROM media_references
            WHERE referent_type = 'content_block' AND referent_id = ${op.blockId}
          `)
        }
        await audit(
          'delete',
          'content_block',
          String(op.blockId),
          row.kind === 'widget'
            ? {
                kind: AUDIT_KIND.delete,
                block_type: row.block_type,
                version: row.version,
                data_hash: createHash('sha256')
                  .update(row.data)
                  .digest('hex'),
                byte_size: row.data.length,
              }
            : {
                kind: AUDIT_KIND.delete,
                container_kind: row.kind,
                block_type: row.block_type,
                version: row.version,
                cascade_ids: deletedIds,
              },
        )
        for (const t of tagsForBlockSave(pageSlug, row.block_type).tags) {
          tags.add(t)
        }
        results.push({ op: 'delete', id: op.blockId, deletedIds })
      } else {
        // reorderChildren
        const parentId = resolveParent(op.parent, i)
        // Verify a non-null parent exists ON THIS PAGE (and lock it, same
        // deadlock-ordering discipline as create) before reading its
        // children. The page-scoped UPDATE below already makes a forged
        // parent harmless, but without this an off-page / missing parent
        // would surface as a confusing incomplete_reorder instead of a
        // precise parent_not_found — matching the create-op contract.
        if (parentId !== null) {
          const [pr] = (await tx.execute(sql`
            SELECT id, page_id FROM content_blocks
            WHERE id = ${parentId} AND deleted_at IS NULL
            FOR UPDATE
          `)) as unknown as [Array<{ id: number; page_id: number }>]
          if (!pr[0] || pr[0].page_id !== pageId) {
            throw opErr(i, 404, 'parent_not_found')
          }
        }
        const [living] = (await tx.execute(sql`
          SELECT id FROM content_blocks
          WHERE page_id = ${pageId} AND deleted_at IS NULL
            AND parent_id ${parentId === null ? sql`IS NULL` : sql`= ${parentId}`}
          FOR UPDATE
        `)) as unknown as [Array<{ id: number }>]
        const livingIds = new Set(living.map((r) => r.id))
        const seen = new Set<number>()
        for (const id of op.orderedBlockIds) {
          if (seen.has(id)) throw opErr(i, 409, 'duplicate_block_id')
          seen.add(id)
          if (!livingIds.has(id)) throw opErr(i, 409, 'not_a_child')
        }
        if (seen.size !== livingIds.size) {
          throw opErr(i, 409, 'incomplete_reorder')
        }
        const positionCases = op.orderedBlockIds.map(
          (id, idx) => sql`WHEN ${id} THEN ${(idx + 1) * 1000}`,
        )
        await tx.execute(sql`
          UPDATE content_blocks
          SET position = CASE id ${sql.join(positionCases, sql.raw(' '))} END,
              version = version + 1, updated_by = ${ctx.userId}
          WHERE id IN (${sql.join(op.orderedBlockIds, sql.raw(','))})
            AND page_id = ${pageId} AND deleted_at IS NULL
        `)
        // Keep the append cursor consistent with the new top position.
        posCursor.set(
          parentId === null ? 'null' : String(parentId),
          op.orderedBlockIds.length * 1000,
        )
        await audit('reorder', 'page', String(pageId), {
          kind: AUDIT_KIND.reorder,
          cross_parent: false,
          groups: [{ parent_id: parentId, order: op.orderedBlockIds }],
        })
        for (const t of tagsForBlockSave(pageSlug).tags) tags.add(t)
        results.push({
          op: 'reorderChildren',
          parentId,
          order: op.orderedBlockIds,
        })
      }
    }

    // Drive the ops. Any error rolls back the ENTIRE batch (one TX) and is
    // re-tagged op[<i>]:<code> so the caller knows which op failed: a bare
    // HttpError from a shared helper (assertMediaAvailable → media_missing)
    // gets the index attached, and a duplicate-key 1062 from the
    // migration-0014 htmlId unique index (a concurrent TX committing the
    // same htmlId between our app-level check and our write) maps to the
    // same clean 409 html_id_collision the per-block route returns.
    for (let i = 0; i < body.ops.length; i += 1) {
      try {
        await applyOp(i, body.ops[i]!)
      } catch (e) {
        if (e instanceof HttpError) {
          if (!e.code.startsWith('op[')) {
            throw new HttpError(e.status, `op[${i}]:${e.code}`)
          }
          throw e
        }
        if (isDuplicateKey(e)) {
          throw new HttpError(409, `op[${i}]:html_id_collision`)
        }
        if (e instanceof ZodError) {
          throw new HttpError(400, `op[${i}]:invalid_request`)
        }
        throw e
      }
    }

    // 3. ONE pages.version bump for the whole batch. Every concurrent
    //    in-flight per-block PATCH/DELETE/reorder holding the pre-batch
    //    pageVersion cursor will now 409 and re-fetch — the same
    //    page-version contract the per-block routes enforce, just charged
    //    once instead of once-per-op.
    await tx.execute(sql`
      UPDATE pages
      SET version = version + 1, updated_at = NOW(3), updated_by = ${ctx.userId}
      WHERE id = ${pageId}
    `)
    const newPageVersion = pageRow.version + 1

    // 4. ONE coalesced revalidate for the union of every op's tags. The
    //    intent row commits inside the TX; the post-commit microtask
    //    drains it without blocking the response.
    const tagList = [...tags]
    const queueRowId = tagList.length
      ? await enqueueRevalidate(tx, tagList)
      : null

    return {
      newPageVersion,
      results,
      tempIds: Object.fromEntries(tempIdMap),
      tags: tagList,
      queueRowId,
    }
  })

  if (txResult.queueRowId !== null) {
    queueMicrotask(() => {
      void drainRevalidate(txResult.queueRowId!, txResult.tags)
    })
  }

  return new Response(
    JSON.stringify({
      pageVersion: txResult.newPageVersion,
      tempIds: txResult.tempIds,
      results: txResult.results,
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    },
  )
})

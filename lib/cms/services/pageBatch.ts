import 'server-only'
import { createHash } from 'node:crypto'
import diff from 'microdiff'
import { z, ZodError } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { HttpError } from '@/lib/auth/requireRole'
import { isDuplicateKey } from '@/lib/db/errors'
import { parseAndSanitize } from '@/lib/cms/parse'
import { collectMediaPaths } from '@/lib/cms/mediaRefs'
import { assertMediaAvailable } from '@/lib/cms/mediaCheck'
import { blockSchemas, FIXED_BLOCK_KEYS_PER_PAGE } from '@/lib/cms/block-registry'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import { AUDIT_DIFF_CAP, capAuditDiff, type DiffOp } from '@/lib/cms/saveBlock'
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
// applyPageBatch — the page-tree batch ENGINE, extracted verbatim from the
// POST /api/cms/pages/[id]/batch route so the HTTP route AND the MCP `edit_page`
// tool drive the IDENTICAL transaction (one TX, one pages.version bump, one
// coalesced revalidate, per-op audit). The route keeps the request-coupled
// concerns (requireRole / requireCsrf / requireScope / per-op rate limit / URL
// id parse); everything below is pure given an explicit context.
//
// Op vocabulary, bounds, optimistic-lock semantics, and per-op error codes are
// UNCHANGED from the original route — see the inline comments. Callers parse
// input with the exported `BatchBody` schema (shared, so HTTP and MCP validate
// identically) and pass the validated `ops` in.
// ─────────────────────────────────────────────────────────────────────

const MAX_OPS = 50
const MAX_ORDERED_IDS = 500
const TEMP_REF_RE = /^[A-Za-z0-9_-]{1,64}$/

const TempRef = z.object({ ref: z.string().regex(TEMP_REF_RE) }).strict()
const ParentTarget = z.union([
  z.number().int().positive(),
  z.null(),
  TempRef,
])

const CreateOp = z
  .object({
    op: z.literal('create'),
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
    expectedVersion: z.number().int().nonnegative().optional(),
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
    orderedBlockIds: z
      .array(z.number().int().positive())
      .min(1)
      .max(MAX_ORDERED_IDS),
  })
  .strict()

export const BatchOp = z.discriminatedUnion('op', [
  CreateOp,
  PatchDataOp,
  PatchMetaOp,
  DeleteOp,
  ReorderOp,
])

export const BatchBody = z
  .object({
    pageVersion: z.number().int().nonnegative().optional(),
    ops: z.array(BatchOp).min(1).max(MAX_OPS),
  })
  .strict()

export type BatchBodyInput = z.infer<typeof BatchBody>
export type BatchOpInput = z.infer<typeof BatchOp>

// Whether a delete op is present — callers use this to decide scope
// (blocks:delete) + so the MCP tool can gate destructive confirmation.
export function batchHasDelete(ops: BatchOpInput[]): boolean {
  return ops.some((o) => o.op === 'delete')
}
export function batchHasNonDelete(ops: BatchOpInput[]): boolean {
  return ops.some((o) => o.op !== 'delete')
}

function extractHtmlId(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined
  const v = (meta as { htmlId?: unknown }).htmlId
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

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

function opErr(index: number, status: number, code: string): HttpError {
  return new HttpError(status, `op[${index}]:${code}`)
}

interface CreateRow {
  id: number
  kind: BlockKind
  page_id: number
}

export interface ApplyPageBatchArgs {
  pageId: number
  userId: number
  // Acting API token id (null for cookie-session writes) — stamped on every
  // per-op audit row so a batch attributes to the agent that ran it.
  tokenId: number | null
  ops: BatchOpInput[]
  pageVersion?: number
  ip: string | null
  userAgent: string | null
  requestId: string | null
}

export interface ApplyPageBatchResult {
  pageVersion: number
  tempIds: Record<string, number>
  results: Array<Record<string, unknown>>
}

// Applies a validated batch in ONE transaction. Throws HttpError(`op[i]:code`)
// on any per-op failure (whole batch rolls back). The caller maps HttpError to
// its surface (route → HTTP status via withError; MCP tool → isError text).
export async function applyPageBatch(
  args: ApplyPageBatchArgs,
): Promise<ApplyPageBatchResult> {
  const { pageId, userId, tokenId, ops } = args

  const txResult = await db.transaction(async (tx) => {
    const [pageRows] = (await tx.execute(sql`
      SELECT id, slug, version FROM pages
      WHERE id = ${pageId} AND deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [Array<{ id: number; slug: string; version: number }>]
    const pageRow = pageRows[0]
    if (!pageRow) throw new HttpError(404, 'page_not_found')
    if (args.pageVersion !== undefined && pageRow.version !== args.pageVersion) {
      throw new HttpError(409, 'stale_page_version')
    }
    const pageSlug = pageRow.slug

    const tempIdMap = new Map<string, number>()
    const tags = new Set<string>()
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
        userId,
        tokenId,
        action,
        resourceType,
        resourceId,
        diff: auditDiff as unknown as object,
        ip: args.ip,
        userAgent: args.userAgent,
        requestId: args.requestId,
      })
    }

    const applyOp = async (i: number, op: BatchOpInput): Promise<void> => {
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
            ${position}, ${insertData}, ${insertMeta}, 0, ${userId}
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
          SET data = ${parsedJson}, version = ${newVersion}, updated_by = ${userId}
          WHERE id = ${op.blockId}
        `)

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
          SET meta = ${metaJson}, version = ${newVersion}, updated_by = ${userId}
          WHERE id = ${op.blockId}
        `)
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
          SET deleted_at = NOW(3), version = version + 1, updated_by = ${userId}
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
              version = version + 1, updated_by = ${userId}
          WHERE id IN (${sql.join(op.orderedBlockIds, sql.raw(','))})
            AND page_id = ${pageId} AND deleted_at IS NULL
        `)
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

    for (let i = 0; i < ops.length; i += 1) {
      try {
        await applyOp(i, ops[i]!)
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

    await tx.execute(sql`
      UPDATE pages
      SET version = version + 1, updated_at = NOW(3), updated_by = ${userId}
      WHERE id = ${pageId}
    `)
    const newPageVersion = pageRow.version + 1

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

  return {
    pageVersion: txResult.newPageVersion,
    tempIds: txResult.tempIds,
    results: txResult.results,
  }
}

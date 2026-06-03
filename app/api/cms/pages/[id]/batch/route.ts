import { z, ZodError } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkCmsMutationRate } from '@/lib/auth/cmsRateLimit'
import { isDuplicateKey } from '@/lib/db/errors'
import { parseAndSanitize } from '@/lib/cms/parse'
import { collectMediaPaths } from '@/lib/cms/mediaRefs'
import { assertMediaAvailable } from '@/lib/cms/mediaCheck'
import { blockSchemas, FIXED_BLOCK_KEYS_PER_PAGE } from '@/lib/cms/block-registry'
import { ensureDraftBaseline, recordDraftRevision } from '@/lib/cms/draft'
import {
  SectionMetaSchema,
  ColumnMetaSchema,
  WidgetMetaSchema,
  DEFAULT_SECTION_META,
  MAX_SECTION_COLUMNS,
  type BlockKind,
} from '@/lib/cms/blockMeta'

// ─────────────────────────────────────────────────────────────────────
// POST /api/cms/pages/[id]/batch — the AGENT FAST-LANE (DRAFT overlay).
//
// Why this endpoint exists. Editing a page through the per-block PATCH
// surface is structurally serial: a client scripting "recolor 12 sections
// + retitle 5 headings" must GET the whole tree, then fire N PATCHes — one
// per block. This endpoint collapses that into one request → one
// transaction. Direct SQL would do it in one multi-row UPDATE, but skip
// the API's safety boundary; this preserves it.
//
// Draft → Publish (migration 0028): every op writes the DRAFT overlay
// (draft_data / draft_meta / draft_position / draft_parent_id +
// draft_state), NEVER the live columns the public site renders. The public
// page is unchanged until the operator clicks Publish, which COALESCEs the
// draft columns into the live ones. Because the draft is a single
// operator's private working copy, draft writes are LAST-WRITE-WINS:
//   • NO optimistic-lock checks — body.pageVersion / per-op expectedVersion
//     are ignored (they remain accepted in the body for back-compat), and
//     stale_version is never thrown.
//   • pages.version (the PUBLISHED lock) is NOT bumped. The whole batch
//     bumps pages.draft_version + has_draft ONCE so a second editor tab can
//     detect "draft changed elsewhere".
//   • NO revalidate — a draft write doesn't touch the public render; Publish
//     handles cache invalidation.
//
// One ensureDraftBaseline(seq 0) at the start of the TX + one
// recordDraftRevision at the end give the whole batch a single undo step.
//
// Every per-op apply still runs the FULL write boundary: Zod + DOMPurify
// (parseAndSanitize), container-meta schema validation, per-page htmlId
// uniqueness, media-reference availability, the column-count cap, the
// fixed-slot reservation, and forward-ref tempId resolution.
//
// Reachable by bearer API tokens (path starts with /api/cms/ →
// tokenAllowedPath) AND by the session-cookie dashboard. CSRF is enforced
// for cookie callers and skipped for bearer tokens. Roles: admin + editor.
// ─────────────────────────────────────────────────────────────────────

const ID_PATTERN = /^[1-9][0-9]{0,9}$/
function parseId(raw: string): number {
  if (!ID_PATTERN.test(raw)) throw new HttpError(400, 'invalid_id')
  return Number(raw)
}

// draft_state transition shared by every modify op: a row that was 'added'
// in this draft stays 'added' (it's draft-only either way); a 'live' (or
// 'modified') row becomes 'modified'.
const DRAFT_STATE_CASE = sql.raw(
  "CASE WHEN draft_state = 'added' THEN 'added' ELSE 'modified' END",
)

// Bounds. The whole batch runs in ONE transaction holding the page row
// FOR UPDATE, and each op issues several sequential DB round-trips, so the
// page-write lock is held for roughly (ops × round-trips). MAX_OPS caps
// that locked window. readJsonBody already caps the envelope at 256 KB.
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
    // Accepted for back-compat; IGNORED (draft writes are last-write-wins).
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
    // Accepted for back-compat; IGNORED (draft writes are last-write-wins).
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
// merge bases. A corrupt blob degrades to {} rather than crashing the
// whole batch with a SyntaxError.
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
  // would otherwise cost the same budget as a single PATCH. The charge
  // happens before any DB work, so an over-limit batch 429s without
  // touching the page.
  // Scope the batch PER-OP against the `blocks` resource, mirroring the
  // dedicated per-block routes (blocks/[id] PATCH = blocks:write, DELETE =
  // blocks:delete). The batch is the agent fast-lane for the SAME
  // content_blocks mutations, so it MUST enforce the same scope ceiling: a
  // token granted only blocks:write cannot delete via a batch delete op, and a
  // token with no blocks grant cannot create/patch/reorder blocks here. (A
  // null-scope or cookie-session caller is unaffected — requireScope no-ops.)
  if (body.ops.some((o) => o.op !== 'delete')) {
    requireScope(ctx, 'blocks', 'write')
  }
  if (body.ops.some((o) => o.op === 'delete')) {
    requireScope(ctx, 'blocks', 'delete')
  }
  for (let i = 0; i < body.ops.length; i += 1) checkCmsMutationRate(ctx)

  const txResult = await db.transaction(async (tx) => {
    // 1. Lock the page row FIRST (deadlock pre-emption — same lock order
    //    as the draft routes: pages → content_blocks). NO optimistic-lock
    //    check — draft writes are last-write-wins. We echo the UNCHANGED
    //    published version back to the caller and bump pages.draft_version
    //    once at the end for the entire batch.
    const [pageRows] = (await tx.execute(sql`
      SELECT id, slug, version FROM pages
      WHERE id = ${pageId} AND deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [Array<{ id: number; slug: string; version: number }>]
    const pageRow = pageRows[0]
    if (!pageRow) throw new HttpError(404, 'page_not_found')
    const pageSlug = pageRow.slug

    // Record the clean baseline (seq 0) BEFORE any change so undo can return
    // to the published state. No-op if the page already has a draft history.
    await ensureDraftBaseline(tx, pageId, ctx.userId)

    const tempIdMap = new Map<string, number>()
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
        // Draft insert: draft_state='added'. The live data/position/parent_id
        // columns carry the content (exactly like the POST insert route) so
        // Publish materialises the row by flipping it back to 'live'; the
        // editor's draft hydrate INCLUDES it while the public hydrate EXCLUDES
        // it until then.
        const [ins] = (await tx.execute(sql`
          INSERT INTO content_blocks
            (page_id, parent_id, kind, block_type, position, data, meta, version, updated_by, draft_state)
          VALUES (
            ${pageId}, ${parentId}, ${kind}, ${insertBlockType},
            ${position}, ${insertData}, ${insertMeta}, 0, ${ctx.userId}, 'added'
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

        if (op.tempId) {
          if (tempIdMap.has(op.tempId)) throw opErr(i, 400, 'duplicate_temp_id')
          tempIdMap.set(op.tempId, newId)
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
          SELECT id, kind, block_type, data, draft_data FROM content_blocks
          WHERE id = ${op.blockId} AND page_id = ${pageId} AND deleted_at IS NULL
          FOR UPDATE
        `)) as unknown as [
          Array<{
            id: number
            kind: BlockKind
            block_type: string
            data: string
            draft_data: string | null
          }>,
        ]
        const row = rows[0]
        if (!row) throw opErr(i, 404, 'not_found')
        if (row.kind !== 'widget') throw opErr(i, 400, 'wrong_field_for_kind')

        // Merge base for dataPatch = the EFFECTIVE draft data
        // (COALESCE(draft_data, data)) so a partial patch builds on any
        // earlier draft edit, not the stale published value.
        const baseData = asObject(row.draft_data ?? row.data)
        const candidate = hasFull
          ? op.data
          : { ...baseData, ...(op.dataPatch as Record<string, unknown>) }
        let parsed: unknown
        try {
          parsed = parseAndSanitize(row.block_type, candidate)
        } catch (e) {
          if (e instanceof ZodError) throw opErr(i, 400, 'invalid_data')
          throw e
        }
        const parsedJson = JSON.stringify(parsed)
        await tx.execute(sql`
          UPDATE content_blocks
          SET draft_data = ${parsedJson}, draft_state = ${DRAFT_STATE_CASE}
          WHERE id = ${op.blockId}
        `)

        // Media-reference availability for any NEW media the draft data
        // introduces (relative to the effective base). We do NOT rewrite
        // media_references here — those track the LIVE content; Publish
        // rebuilds them from the materialised data. But the referenced
        // media must still exist so Publish can't strand a dangling ref.
        const baseRefs = collectMediaPaths(baseData)
        const newRefs = collectMediaPaths(parsed)
        const baseSet = new Set(baseRefs.map((r) => `${r.mediaId}::${r.field}`))
        const newMediaIds = [
          ...new Set(
            newRefs
              .filter((r) => !baseSet.has(`${r.mediaId}::${r.field}`))
              .map((r) => r.mediaId),
          ),
        ]
        await assertMediaAvailable(tx, newMediaIds)

        results.push({ op: 'patchData', id: op.blockId, version: 0 })
      } else if (op.op === 'patchMeta') {
        const hasFull = op.meta !== undefined
        const hasPatch = op.metaPatch !== undefined
        if (hasFull === hasPatch) {
          throw opErr(i, 400, 'exactly_one_of_meta_or_meta_patch')
        }
        const [rows] = (await tx.execute(sql`
          SELECT id, kind, block_type, meta, draft_meta FROM content_blocks
          WHERE id = ${op.blockId} AND page_id = ${pageId} AND deleted_at IS NULL
          FOR UPDATE
        `)) as unknown as [
          Array<{
            id: number
            kind: BlockKind
            block_type: string
            meta: string | null
            draft_meta: string | null
          }>,
        ]
        const row = rows[0]
        if (!row) throw opErr(i, 404, 'not_found')

        // Merge base for metaPatch = the EFFECTIVE draft meta
        // (COALESCE(draft_meta, meta)).
        const baseMeta = asObject(row.draft_meta ?? row.meta)
        const patchObj = (op.metaPatch ?? {}) as Record<string, unknown>
        let parsedMeta: unknown
        try {
          if (row.kind === 'section') {
            const candidate = hasFull
              ? op.meta
              : { ...DEFAULT_SECTION_META, ...baseMeta, ...patchObj }
            parsedMeta = SectionMetaSchema.parse(candidate)
          } else if (row.kind === 'column') {
            const candidate = hasFull ? op.meta : { ...baseMeta, ...patchObj }
            parsedMeta = ColumnMetaSchema.parse(candidate)
          } else {
            const candidate = hasFull ? op.meta : { ...baseMeta, ...patchObj }
            parsedMeta = WidgetMetaSchema.parse(candidate)
          }
        } catch (e) {
          if (e instanceof ZodError) throw opErr(i, 400, 'invalid_meta')
          throw e
        }
        const metaJson = JSON.stringify(parsedMeta)
        const htmlId = extractHtmlId(parsedMeta)
        if (htmlId) await assertHtmlIdFree(htmlId, op.blockId, i)

        await tx.execute(sql`
          UPDATE content_blocks
          SET draft_meta = ${metaJson}, draft_state = ${DRAFT_STATE_CASE}
          WHERE id = ${op.blockId}
        `)
        results.push({ op: 'patchMeta', id: op.blockId, version: 0 })
      } else if (op.op === 'delete') {
        const [rows] = (await tx.execute(sql`
          SELECT block_key, kind, draft_state FROM content_blocks
          WHERE id = ${op.blockId} AND page_id = ${pageId} AND deleted_at IS NULL
          FOR UPDATE
        `)) as unknown as [
          Array<{
            block_key: string | null
            kind: BlockKind
            draft_state: string
          }>,
        ]
        const row = rows[0]
        if (!row) throw opErr(i, 404, 'not_found')
        if (row.block_key !== null) {
          throw opErr(i, 409, 'cannot_delete_fixed_block')
        }

        // Subtree collection — mirror lib/cms/draft.ts deleteDraftBlock. The
        // subtree walk considers BOTH live parent_id AND draft_parent_id so a
        // draft-reparented descendant is still swept. Widgets have no
        // children → the set is just the row itself.
        let subtreeIds = [op.blockId]
        if (row.kind !== 'widget') {
          const [kids] = (await tx.execute(sql`
            SELECT id FROM content_blocks
            WHERE page_id = ${pageId} AND deleted_at IS NULL
              AND (id = ${op.blockId}
                   OR parent_id = ${op.blockId}
                   OR draft_parent_id = ${op.blockId}
                   OR parent_id IN (SELECT id FROM (
                        SELECT id FROM content_blocks
                        WHERE page_id = ${pageId} AND parent_id = ${op.blockId}
                      ) AS cols)
                   OR draft_parent_id IN (SELECT id FROM (
                        SELECT id FROM content_blocks
                        WHERE page_id = ${pageId} AND parent_id = ${op.blockId}
                      ) AS cols2))
          `)) as unknown as [Array<{ id: number }>]
          subtreeIds = [...new Set([op.blockId, ...kids.map((k) => k.id)])]
        }
        const idList = sql.join(subtreeIds, sql.raw(','))

        // Hard-delete rows added in THIS draft (never existed publicly);
        // flip the rest to 'removed' (public keeps showing them until
        // Publish; the editor's draft view excludes them). No version bump,
        // no deleted_at stamp — the draft layer is unlocked + invisible to
        // the public.
        await tx.execute(sql`
          DELETE FROM content_blocks
          WHERE page_id = ${pageId} AND id IN (${idList}) AND draft_state = 'added'
        `)
        await tx.execute(sql`
          UPDATE content_blocks
          SET draft_state = 'removed'
          WHERE page_id = ${pageId} AND id IN (${idList}) AND draft_state <> 'added'
        `)
        // media_references track LIVE content (Publish rebuilds them on
        // materialise); a draft delete leaves them untouched until then.
        results.push({ op: 'delete', id: op.blockId, deletedIds: subtreeIds })
      } else {
        // reorderChildren
        const parentId = resolveParent(op.parent, i)
        // Verify a non-null parent exists ON THIS PAGE (and lock it, same
        // deadlock-ordering discipline as create) before reading its
        // children.
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
        // Living children read from the LIVE parent_id column (the published
        // membership), matching the /reorder route's drift contract. The
        // submission must be COMPLETE for that membership.
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
        // Draft reorder: write draft_position (and draft_parent_id, since a
        // reorderChildren op declares the parent every listed child should
        // live under) + flip draft_state. The live position/parent_id are
        // UNTOUCHED — Publish COALESCEs the draft columns in.
        const positionCases = op.orderedBlockIds.map(
          (id, idx) => sql`WHEN ${id} THEN ${(idx + 1) * 1000}`,
        )
        await tx.execute(sql`
          UPDATE content_blocks
          SET draft_position = CASE id ${sql.join(positionCases, sql.raw(' '))} END,
              draft_parent_id = ${parentId},
              draft_state = ${DRAFT_STATE_CASE}
          WHERE id IN (${sql.join(op.orderedBlockIds, sql.raw(','))})
            AND page_id = ${pageId} AND deleted_at IS NULL
        `)
        // Keep the append cursor consistent with the new top position.
        posCursor.set(
          parentId === null ? 'null' : String(parentId),
          op.orderedBlockIds.length * 1000,
        )
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
    // migration-0014 htmlId unique index maps to the same clean 409
    // html_id_collision the per-block route returns.
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

    // 3. ONE draft-cursor bump for the whole batch — pages.draft_version +
    //    has_draft + draft_updated_at/_by. The PUBLISHED pages.version is
    //    NOT touched (Publish bumps it). draft_version advancing lets a
    //    second editor tab detect "draft changed elsewhere".
    await tx.execute(sql`
      UPDATE pages
      SET draft_version = draft_version + 1,
          has_draft = 1,
          draft_updated_at = NOW(3),
          draft_updated_by = ${ctx.userId}
      WHERE id = ${pageId}
    `)
    // 4. Record ONE undo step for the whole batch (the post-change draft
    //    state). A draft write does NOT change the public render → NO
    //    revalidate here; Publish materialises + invalidates the cache.
    await recordDraftRevision(
      tx,
      pageId,
      ctx.userId,
      `AI batch (${body.ops.length} ops)`,
    )

    // Echo the UNCHANGED published version (draft writes never bump it).
    return {
      pageVersion: pageRow.version,
      results,
      tempIds: Object.fromEntries(tempIdMap),
    }
  })

  return new Response(
    JSON.stringify({
      pageVersion: txResult.pageVersion,
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

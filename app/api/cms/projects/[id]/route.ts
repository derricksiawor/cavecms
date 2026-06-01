import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkCmsMutationRate, checkReadRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { isDuplicateKey } from '@/lib/db/errors'
import { assertMediaAvailable } from '@/lib/cms/mediaCheck'
import { isValidStatusTransition } from '@/lib/cms/projectStatus'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { tagsForProjectSave, tagsForProjectDelete } from '@/lib/cache/tags'

import { SLUG_RE } from '@/lib/cms/slug'
// projects.slug DB column is varchar(120) — narrower than the
// canonical SLUG_MAX (140 mirrors pages/posts). Keep the local
// upper bound aligned with the column.
const SLUG_MAX = 120
const ID_PATTERN = /^[1-9][0-9]{0,9}$/

function parseId(raw: string): number {
  if (!ID_PATTERN.test(raw)) throw new HttpError(400, 'invalid_id')
  return Number(raw)
}

// Editor allowlist: everything except the publishing controls (slug,
// status, published). All optimistic-lock PATCHes carry `version`.
const EditorSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    tagline: z.string().max(220).nullable().optional(),
    location: z.string().max(180).nullable().optional(),
    heroImageId: z.number().int().positive().nullable().optional(),
    brochurePdfId: z.number().int().positive().nullable().optional(),
    featuredOrder: z.number().int().nonnegative().nullable().optional(),
    seoTitle: z.string().max(180).nullable().optional(),
    seoDescription: z.string().max(320).nullable().optional(),
    ogImageId: z.number().int().positive().nullable().optional(),
    version: z.number().int().nonnegative(),
  })
  .strict()

// Admin allowlist extends editor with publishing controls. .strict()
// on both — any unknown key is a ZodError that withError converts to
// 400. Splitting the inferred types lets buildSets refuse to put an
// admin-only column in the editor allowlist at compile time.
const AdminSchema = EditorSchema.extend({
  published: z.boolean().optional(),
  slug: z
    .string()
    .min(2)
    .max(SLUG_MAX)
    .regex(SLUG_RE, 'slug_invalid_format')
    .optional(),
  status: z
    .enum(['coming_soon', 'under_construction', 'selling', 'sold_out'])
    .optional(),
}).strict()

type EditorBody = z.infer<typeof EditorSchema>
type AdminBody = z.infer<typeof AdminSchema>
type Body = AdminBody

interface ProjectRow {
  id: number
  slug: string
  name: string
  tagline: string | null
  status: string
  published: number
  featured_order: number | null
  hero_image_id: number | null
  brochure_pdf_id: number | null
  location: string | null
  seo_title: string | null
  seo_description: string | null
  og_image_id: number | null
  version: number
}

type RouteCtx = { params: Promise<{ id: string }> }

// `version` is the optimistic-lock token, not a column the editor
// can rewrite directly. Excluded from EDITOR_COLS so the loop's
// `field` is correctly typed and no runtime guard is needed.
type EditorFieldNoVersion = Exclude<keyof EditorBody, 'version'>

// Editor columns. The keys are EditorFieldNoVersion-typed so a
// future admin-only field cannot be added here by mistake
// (compile error), and `version` cannot accidentally appear in
// the runtime list.
const EDITOR_COLS: ReadonlyArray<readonly [EditorFieldNoVersion, string]> = [
  ['name', 'name'],
  ['tagline', 'tagline'],
  ['location', 'location'],
  ['heroImageId', 'hero_image_id'],
  ['brochurePdfId', 'brochure_pdf_id'],
  ['featuredOrder', 'featured_order'],
  ['seoTitle', 'seo_title'],
  ['seoDescription', 'seo_description'],
  ['ogImageId', 'og_image_id'],
]

// Admin-only columns. Keys are the AdminBody fields NOT already in
// EditorBody, so typo or accidental crossover is a TS error.
type AdminOnlyKey = Exclude<keyof AdminBody, keyof EditorBody>
const ADMIN_ONLY_COLS: ReadonlyArray<readonly [AdminOnlyKey, string]> = [
  ['published', 'published'],
  ['slug', 'slug'],
  ['status', 'status'],
]

// Map each EditorBody / AdminBody field name to the actual row
// column. buildSets compares body[field] against row[<column>]
// and only emits an UPDATE chunk when they differ — so a client
// that sends back-the-same-value gets a true no-op (idempotent
// retry).
const EDITOR_ROW_COL: Record<EditorFieldNoVersion, keyof ProjectRow> = {
  name: 'name',
  tagline: 'tagline',
  location: 'location',
  heroImageId: 'hero_image_id',
  brochurePdfId: 'brochure_pdf_id',
  featuredOrder: 'featured_order',
  seoTitle: 'seo_title',
  seoDescription: 'seo_description',
  ogImageId: 'og_image_id',
}
const ADMIN_ROW_COL: Record<AdminOnlyKey, keyof ProjectRow> = {
  published: 'published',
  slug: 'slug',
  status: 'status',
}

// Build the dynamic UPDATE SET clause as a list of `column = value`
// sql template fragments joined by sql`, `. Drizzle's sql template
// keeps every value parameterized; column names come from a closed
// allowlist (EDITOR_COLS / ADMIN_ONLY_COLS) so they're safe to
// interpolate via sql.raw.
//
// Returns `applied` = the field→value map ACTUALLY written, only
// including fields whose value differs from `row`. Empty applied
// means no real change — caller may short-circuit the whole save.
function buildSets(
  body: Body,
  row: ProjectRow,
  role: 'admin' | 'editor' | 'viewer',
  ctxUserId: number,
  bumpEpoch: boolean,
  publishedTransition: 'on' | 'off' | 'none',
): {
  setSql: ReturnType<typeof sql.join>
  applied: Partial<AdminBody>
} {
  const parts: ReturnType<typeof sql>[] = []
  const applied: Partial<AdminBody> = {}

  // Always: version + 1 + updated_by. Both are static SQL.
  parts.push(sql`version = version + 1`)
  parts.push(sql`updated_by = ${ctxUserId}`)
  if (bumpEpoch) parts.push(sql`preview_epoch = preview_epoch + 1`)
  if (publishedTransition === 'on') {
    parts.push(sql`published_at = COALESCE(published_at, NOW(3))`)
  }

  for (const [field, col] of EDITOR_COLS) {
    const v = body[field]
    if (v === undefined) continue
    const rowVal = row[EDITOR_ROW_COL[field]] as unknown
    if (v === rowVal) continue
    parts.push(sql`${sql.raw(col)} = ${v}`)
    ;(applied as Record<string, unknown>)[field] = v
  }
  if (role === 'admin') {
    for (const [field, col] of ADMIN_ONLY_COLS) {
      const v = body[field]
      if (v === undefined) continue
      // published is stored as int(0|1) in MySQL; admin sends bool.
      const rowVal: unknown =
        field === 'published'
          ? row.published === 1
          : row[ADMIN_ROW_COL[field]]
      if (v === rowVal) continue
      parts.push(sql`${sql.raw(col)} = ${v}`)
      ;(applied as Record<string, unknown>)[field] = v
    }
  }

  return { setSql: sql.join(parts, sql`, `), applied }
}

// ─── GET /api/cms/projects/[id] — single project for editor load ────
// Read-modify-write surface. The list endpoint returns only card fields
// (slug, name, status, featured_order, published) — not the editable
// scalars tagline / location / seo* / hero / brochure. Without this an
// agent or editor could PATCH those fields but never read the current
// value first. Returns every column a PATCH can write. Trashed rows are
// admin + editor only (viewer → 404), mirroring the pages GET.
export const GET = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin', 'editor', 'viewer'])
  checkReadRate(ctx.userId)

  const [rows] = (await db.execute(sql`
    SELECT * FROM projects WHERE id = ${id}
  `)) as unknown as [Array<ProjectRow & { deleted_at: string | null }>]
  const project = rows[0]
  if (!project) throw new HttpError(404, 'not_found')
  if (project.deleted_at !== null && ctx.role === 'viewer') {
    throw new HttpError(404, 'not_found')
  }

  return new Response(JSON.stringify({ project }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})

export const PATCH = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'projects', 'write')
  checkCmsMutationRate(ctx)

  const raw = await readJsonBody(req)
  const Schema = ctx.role === 'admin' ? AdminSchema : EditorSchema
  const meta = auditMetaFromRequest(req)

  let body: Body
  try {
    body = Schema.parse(raw) as Body
  } catch (e) {
    // RBAC visibility audit: if an editor sent admin-only fields,
    // log the rejection (with key names only) before returning 403.
    if (ctx.role === 'editor' && raw && typeof raw === 'object') {
      const adminOnly = new Set<string>(ADMIN_ONLY_COLS.map(([k]) => k))
      const offending = Object.keys(raw as Record<string, unknown>).filter(
        (k) => adminOnly.has(k),
      )
      if (offending.length > 0) {
        await db.insert(auditLog).values({
          userId: ctx.userId,
          tokenId: ctx.tokenId,
          action: 'rbac_field_reject',
          resourceType: 'project',
          resourceId: String(id),
          diff: {
            kind: AUDIT_KIND.rbacFieldReject,
            keys: offending,
          } as unknown as object,
          ip: meta.ip,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        })
        throw new HttpError(403, 'forbidden')
      }
    }
    throw e
  }

  // slugChanged lifted to outer scope so the catch block can gate
  // the duplicate-key translation: only a slug rename should map
  // ER_DUP_ENTRY → slug_taken. Any other unique-index violation
  // (slug_redirects collisions, future unique constraints) surfaces
  // as a generic 409 conflict so audit triage isn't lied to.
  let slugChangedOuter = false
  try {
    const txResult = await db.transaction(async (tx) => {
      // Fetch every column buildSets / coreChanged need so the
      // delta detection is value-based (not "did the client send
      // this field"). Sending `{name: row.name}` should NOT mark
      // coreChanged=true and over-invalidate the featured-projects
      // / projects-index caches. preview_epoch is mutated via SQL
      // `preview_epoch + 1` so we don't need it on the JS side.
      const [rows] = (await tx.execute(sql`
        SELECT id, slug, name, tagline, status, published, featured_order,
               hero_image_id, brochure_pdf_id, location,
               seo_title, seo_description, og_image_id,
               version
        FROM projects
        WHERE id = ${id} AND deleted_at IS NULL
        FOR UPDATE
      `)) as unknown as [ProjectRow[]]
      const row = rows[0]
      if (!row) throw new HttpError(404, 'not_found')
      if (row.version !== body.version) {
        throw new HttpError(409, 'stale_version')
      }

      // Status state machine. Only enforced when status is in the
      // payload AND differs from current — same-state is a no-op.
      if (
        ctx.role === 'admin' &&
        body.status !== undefined &&
        body.status !== row.status &&
        !isValidStatusTransition(row.status, body.status)
      ) {
        throw new HttpError(409, 'invalid_status_transition')
      }

      const slugChanged =
        ctx.role === 'admin' &&
        body.slug !== undefined &&
        body.slug !== row.slug
      slugChangedOuter = slugChanged
      const publishedTransition: 'on' | 'off' | 'none' =
        ctx.role === 'admin' && body.published !== undefined
          ? (body.published ? 1 : 0) === row.published
            ? 'none'
            : body.published
              ? 'on'
              : 'off'
          : 'none'
      const publishedChanged = publishedTransition !== 'none'
      const featuredChanged =
        body.featuredOrder !== undefined &&
        body.featuredOrder !== row.featured_order

      // Slug rename: insert/update redirect row, collapse chain,
      // drop self-reference. Three statements inside the TX so a
      // crash mid-rename never leaves a half-built redirect map.
      // (Refusing the rename on slug collision lives below in the
      // catch-isDuplicateKey path — pre-checking would still race
      // against a concurrent INSERT.)
      if (slugChanged && body.slug) {
        // 1) Record the rename. ON DUPLICATE KEY catches the case
        //    where this exact old slug already had a stale
        //    redirect.
        await tx.execute(sql`
          INSERT INTO slug_redirects (resource_type, old_slug, new_slug)
          VALUES ('project', ${row.slug}, ${body.slug})
          ON DUPLICATE KEY UPDATE new_slug = VALUES(new_slug)
        `)
        // 2) Collapse the chain. If X→row.slug existed, X should
        //    now point at body.slug directly so callers don't
        //    follow N hops.
        await tx.execute(sql`
          UPDATE slug_redirects
          SET new_slug = ${body.slug}
          WHERE resource_type = 'project' AND new_slug = ${row.slug}
        `)
        // 3) Drop a self-reference if the new slug used to be an
        //    old slug pointing somewhere — without this the
        //    redirect map is self-referential and the page-level
        //    lookup would loop.
        await tx.execute(sql`
          DELETE FROM slug_redirects
          WHERE resource_type = 'project' AND old_slug = ${body.slug}
        `)
        // 4) Keep the project's CMS page row in lockstep. A migrated
        //    project renders its body from a `pages` row whose slug
        //    equals the project slug (see app/projects/[slug]/page.tsx
        //    — it resolves `pages WHERE slug = <project slug>`). Without
        //    this UPDATE a rename would leave the block tree stranded at
        //    the OLD slug, so the project would silently revert to the
        //    legacy render. Runs in the SAME TX as the projects rename:
        //    a `pages.slug` UNIQUE collision (another page already owns
        //    the new slug) throws ER_DUP_ENTRY → the catch maps it to
        //    slug_taken and the whole rename rolls back. `slug` is
        //    globally unique on `pages`, so this touches at most the one
        //    project page row; is_home guard is belt-and-braces (the
        //    home page can never carry a project slug).
        await tx.execute(sql`
          UPDATE pages
          SET slug = ${body.slug}
          WHERE slug = ${row.slug} AND is_home = 0
        `)
      }

      // Bump preview_epoch on slug change OR on unpublish. Both
      // invalidate any preview JWT issued before the change.
      const bumpEpoch = slugChanged || publishedTransition === 'off'

      const { setSql, applied } = buildSets(
        body,
        row,
        ctx.role,
        ctx.userId,
        bumpEpoch,
        publishedTransition,
      )

      // coreChanged uses `applied` (which is already a real-delta
      // map produced by buildSets) so submitting unchanged values
      // never inflates the cache-invalidation surface. Name +
      // tagline + heroImageId are the fields that flow into the
      // featured-projects carousel + projects-index renders.
      const coreChanged =
        applied.name !== undefined ||
        applied.tagline !== undefined ||
        applied.heroImageId !== undefined

      // No-op short-circuit. If nothing actually changed AND no
      // version-affecting side-effects are needed, return the
      // current version untouched. Skips UPDATE + audit + cache
      // invalidation. Idempotent client retries after a timeout
      // hit this path on subsequent attempts.
      const nothingApplied = Object.keys(applied).length === 0
      if (
        nothingApplied &&
        !bumpEpoch &&
        publishedTransition === 'none' &&
        !slugChanged
      ) {
        return {
          newVersion: row.version,
          queueRowId: null as number | null,
          tags: [] as string[],
        }
      }

      await tx.execute(sql`UPDATE projects SET ${setSql} WHERE id = ${id}`)

      // Reconcile media_references for the per-column media pointers
      // (hero_image_id, brochure_pdf_id, og_image_id). The column
      // itself just stores the id — references must also be tracked
      // in media_references so the media DELETE refuses while any
      // project still points at the row. Without this, deleting media
      // would silently leave a dangling pointer on the project.
      const MEDIA_COLS: Array<[
        keyof typeof applied,
        'hero_image_id' | 'brochure_pdf_id' | 'og_image_id',
        number | null,
      ]> = [
        ['heroImageId', 'hero_image_id', row.hero_image_id],
        ['brochurePdfId', 'brochure_pdf_id', row.brochure_pdf_id],
        ['ogImageId', 'og_image_id', row.og_image_id],
      ]
      const newMediaIds: number[] = []
      for (const [appKey, column, oldVal] of MEDIA_COLS) {
        if (applied[appKey] === undefined) continue
        const newVal = applied[appKey] as number | null
        if (newVal === oldVal) continue
        if (oldVal !== null) {
          await tx.execute(sql`
            DELETE FROM media_references
            WHERE media_id = ${oldVal}
              AND referent_type = 'project'
              AND referent_id = ${id}
              AND field = ${column}
          `)
        }
        if (newVal !== null) {
          newMediaIds.push(newVal)
          await tx.execute(sql`
            INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
            VALUES (${newVal}, 'project', ${id}, ${column})
          `)
        }
      }
      if (newMediaIds.length > 0) {
        await assertMediaAvailable(tx, newMediaIds)
      }

      // Audit `from` mirrors every editable column so forensic
      // triage can reconstruct the prior value of ANY field the
      // PATCH touched. `to` is the real-delta map (applied only
      // when value actually changed). Keep `from` complete; the
      // 64KB diff cap (saveBlock.AUDIT_DIFF_CAP) protects against
      // outsized payloads on the audit_log side if needed.
      await tx.insert(auditLog).values({
        userId: ctx.userId,
        tokenId: ctx.tokenId,
        action: 'update',
        resourceType: 'project',
        resourceId: String(id),
        diff: {
          kind: AUDIT_KIND.patch,
          from: {
            slug: row.slug,
            name: row.name,
            tagline: row.tagline,
            status: row.status,
            published: row.published === 1,
            featured_order: row.featured_order,
            hero_image_id: row.hero_image_id,
            brochure_pdf_id: row.brochure_pdf_id,
            location: row.location,
            seo_title: row.seo_title,
            seo_description: row.seo_description,
            og_image_id: row.og_image_id,
          },
          to: applied,
          bumpedPreviewEpoch: bumpEpoch,
          slugChanged,
          publishedTransition,
        } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })

      const newSlug = body.slug ?? row.slug
      // tagsForProjectSave now owns the old-slug invalidation (page
      // tag AND admin-bar slug-resolver tag) — pass the pre-rename
      // slug when slugChanged so a single source of truth handles
      // both fresh and stale caches.
      const tagSet = tagsForProjectSave(newSlug, {
        publishedChanged,
        slugChanged,
        oldSlug: slugChanged ? row.slug : undefined,
        featuredChanged,
        coreChanged,
      }).tags

      const queueRowId = await enqueueRevalidate(tx, tagSet)
      return { newVersion: row.version + 1, queueRowId, tags: tagSet }
    })

    if (txResult.queueRowId !== null) {
      const rowId = txResult.queueRowId
      const tags = txResult.tags
      queueMicrotask(() => {
        void drainRevalidate(rowId, tags)
      })
    }

    return new Response(JSON.stringify({ ok: true, version: txResult.newVersion }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    })
  } catch (err: unknown) {
    // Concurrent create or rename to the same slug races the
    // UNIQUE constraint on projects.slug. Translate to a clean
    // 409 — but only when the request ACTUALLY attempted a slug
    // rename. Other unique-index violations (slug_redirects or a
    // future unique constraint) surface as a generic 409 conflict
    // so audit triage isn't misled by an inaccurate code.
    if (isDuplicateKey(err)) {
      throw new HttpError(409, slugChangedOuter ? 'slug_taken' : 'conflict')
    }
    throw err
  }
})

// Soft delete. Admin-only. Bumps preview_epoch so any outstanding
// preview token resolves to a 404 immediately. The row stays in the
// table until the cron purge (Plan 09) hard-removes after 30 days
// with zero media_references.
export const DELETE = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'projects', 'delete')
  checkCmsMutationRate(ctx)

  const meta = auditMetaFromRequest(req)

  const txResult = await db.transaction(async (tx) => {
    const [rows] = (await tx.execute(sql`
      SELECT id, slug FROM projects
      WHERE id = ${id} AND deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [Array<{ id: number; slug: string }>]
    const row = rows[0]
    if (!row) throw new HttpError(404, 'not_found')

    await tx.execute(sql`
      UPDATE projects
      SET deleted_at = NOW(3),
          preview_epoch = preview_epoch + 1,
          updated_by = ${ctx.userId}
      WHERE id = ${id}
    `)

    await tx.insert(auditLog).values({
      userId: ctx.userId,
      tokenId: ctx.tokenId,
      action: 'delete',
      resourceType: 'project',
      resourceId: String(id),
      diff: { kind: AUDIT_KIND.delete, slug: row.slug } as unknown as object,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })

    // Route through the centralised tag helper so the resolver tag
    // never gets dropped — hand-rolled arrays in DELETE handlers
    // were the bug that prompted this refactor.
    const tags = tagsForProjectDelete(row.slug).tags
    const queueRowId = await enqueueRevalidate(tx, tags)
    return { queueRowId, tags }
  })

  queueMicrotask(() => {
    void drainRevalidate(txResult.queueRowId, txResult.tags)
  })

  return new Response(null, { status: 204 })
})

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate, checkReadRate } from '@/lib/auth/cmsRateLimit'
import { assertMediaAvailable } from '@/lib/cms/mediaCheck'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { isDuplicateKey } from '@/lib/db/errors'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { notifyIndexNow } from '@/lib/seo/indexnow/notify'
import { tagsForPostSave, tagsForPostDelete } from '@/lib/cache/tags'
import { SeoEditorFields } from '@/lib/cms/seoEditorFields'
import { buildSeoSetParts } from '@/lib/cms/seoEditorPersist'

import { SLUG_RE, SLUG_MAX } from '@/lib/cms/slug'
const ID_PATTERN = /^[1-9][0-9]{0,9}$/
// MediumText column on MySQL holds 16MB; cap inbound body_md well
// under readJsonBody's 256KB envelope cap. Worst-case JSON escaping
// adds ~5% (newlines, quotes, backslashes) and the envelope itself
// is ~100 bytes — 180K chars leaves headroom so a 250K-character
// post never trips body_too_large. The textarea + previewMarkdown
// caps match.
const BODY_MD_MAX = 180_000

function parseId(raw: string): number {
  if (!ID_PATTERN.test(raw)) throw new HttpError(400, 'invalid_id')
  return Number(raw)
}

// Editor allowlist: every editable column except publishing controls
// (published, slug). All optimistic-lock PATCHes carry `version`.
const EditorSchema = z
  .object({
    title: z.string().min(1).max(220).optional(),
    excerpt: z.string().max(320).nullable().optional(),
    bodyMd: z.string().max(BODY_MD_MAX).optional(),
    heroImageId: z.number().int().positive().nullable().optional(),
    seoTitle: z.string().max(180).nullable().optional(),
    seoDescription: z.string().max(320).nullable().optional(),
    ogImageId: z.number().int().positive().nullable().optional(),
    ...SeoEditorFields,
    version: z.number().int().nonnegative(),
  })
  .strict()

// Admin allowlist extends editor with publish + slug. .strict() on
// both — any unknown key trips a ZodError that withError converts
// to 400. Splitting the inferred types lets buildSets refuse to put
// an admin-only column in the editor allow-list at compile time.
const AdminSchema = EditorSchema.extend({
  published: z.boolean().optional(),
  slug: z
    .string()
    .min(2)
    .max(SLUG_MAX)
    .regex(SLUG_RE, 'slug_invalid_format')
    .optional(),
}).strict()

type EditorBody = z.infer<typeof EditorSchema>
type AdminBody = z.infer<typeof AdminSchema>
type Body = AdminBody

// The SEO editor fields (migration 0032) are persisted via the shared
// buildSeoSetParts helper, NOT the generic EDITOR_COLS loop (booleans →
// TINYINT, seoMeta → JSON need bespoke serialization). Subtract their
// keys from the generic-loop field type so the exhaustiveness guards
// below don't demand them in EDITOR_COLS / EDITOR_ROW_COL.
type SeoEditorKey = keyof typeof SeoEditorFields

interface PostRow {
  id: number
  slug: string
  title: string
  excerpt: string | null
  body_md: string
  hero_image_id: number | null
  seo_title: string | null
  seo_description: string | null
  og_image_id: number | null
  published: number
  version: number
  // SEO columns (migration 0032). Booleans come back as 0|1 from raw
  // SQL; seo_meta is the raw JSON string (MariaDB JSON ≡ LONGTEXT).
  focus_keyphrase: string | null
  robots_noindex: number
  robots_nofollow: number
  canonical_url: string | null
  cornerstone: number
  seo_score: number | null
  readability_score: number | null
  seo_meta: unknown
}

type RouteCtx = { params: Promise<{ id: string }> }

// `version` is the optimistic-lock token, not a column the editor
// can rewrite directly. SEO fields are handled by buildSeoSetParts.
// Both excluded so the buildSets loop's `field` type stays narrow and
// no runtime guard is needed.
type EditorFieldNoVersion = Exclude<keyof EditorBody, 'version' | SeoEditorKey>

const EDITOR_COLS: ReadonlyArray<readonly [EditorFieldNoVersion, string]> = [
  ['title', 'title'],
  ['excerpt', 'excerpt'],
  ['bodyMd', 'body_md'],
  ['heroImageId', 'hero_image_id'],
  ['seoTitle', 'seo_title'],
  ['seoDescription', 'seo_description'],
  ['ogImageId', 'og_image_id'],
]

type AdminOnlyKey = Exclude<keyof AdminBody, keyof EditorBody>
const ADMIN_ONLY_COLS: ReadonlyArray<readonly [AdminOnlyKey, string]> = [
  ['published', 'published'],
  ['slug', 'slug'],
]

// Compile-time exhaustiveness guard: every EditorFieldNoVersion /
// AdminOnlyKey must appear in its COLS array. Adding a field to the
// Zod schema + ROW_COL but forgetting it in COLS would silently
// never be written. The Record<…, unknown> assignment forces tsc to
// verify each key is covered.
const _editorColsExhaustive: Record<EditorFieldNoVersion, unknown> =
  Object.fromEntries(EDITOR_COLS) as Record<EditorFieldNoVersion, unknown>
void _editorColsExhaustive
const _adminColsExhaustive: Record<AdminOnlyKey, unknown> =
  Object.fromEntries(ADMIN_ONLY_COLS) as Record<AdminOnlyKey, unknown>
void _adminColsExhaustive

const EDITOR_ROW_COL: Record<EditorFieldNoVersion, keyof PostRow> = {
  title: 'title',
  excerpt: 'excerpt',
  bodyMd: 'body_md',
  heroImageId: 'hero_image_id',
  seoTitle: 'seo_title',
  seoDescription: 'seo_description',
  ogImageId: 'og_image_id',
}
const ADMIN_ROW_COL: Record<AdminOnlyKey, keyof PostRow> = {
  published: 'published',
  slug: 'slug',
}

// Build the dynamic UPDATE SET clause as a list of `column = value`
// sql template fragments joined by sql`, `. Column names come from a
// closed allow-list (EDITOR_COLS / ADMIN_ONLY_COLS) so they're safe
// to interpolate via sql.raw; every value goes through the sql
// template's parameterization.
//
// `applied` is the field→value map ACTUALLY written, only including
// fields whose value differs from the loaded `row`. Empty applied
// means no real change — caller short-circuits the whole save.
function buildSets(
  body: Body,
  row: PostRow,
  role: 'admin' | 'editor' | 'viewer',
  ctxUserId: number,
  publishedTransition: 'on' | 'off' | 'none',
): {
  setSql: ReturnType<typeof sql.join>
  applied: Partial<AdminBody>
} {
  const parts: ReturnType<typeof sql>[] = []
  const applied: Partial<AdminBody> = {}

  parts.push(sql`version = version + 1`)
  parts.push(sql`updated_by = ${ctxUserId}`)
  // First-publish stamps published_at; republish preserves the
  // original so a bookmarked URL doesn't see the date jitter.
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

  // SEO editor fields (migration 0032) — booleans → TINYINT, seoMeta →
  // JSON string, scores → INT|null. Editor-writable like seo_title, so
  // they apply for both roles (outside the admin-only branch).
  const seo = buildSeoSetParts(body, row)
  parts.push(...seo.parts)
  Object.assign(applied as Record<string, unknown>, seo.applied)

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

// ─── GET /api/cms/posts/[id] — single post for editor load ──────────
// Read-modify-write surface. The list endpoint returns only the card
// fields (no body_md / seo / hero), so without this an agent or editor
// could PATCH a post's body but never read the current value to base a
// safe optimistic-lock update on. Returns every column a PATCH can
// write. Trashed rows are admin + editor only (viewer → 404, no oracle
// for "a trashed post exists at this id"), mirroring the pages GET.
export const GET = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin', 'editor', 'viewer'])
  checkReadRate(ctx.userId)

  const [rows] = (await db.execute(sql`
    SELECT * FROM posts WHERE id = ${id}
  `)) as unknown as [Array<PostRow & { deleted_at: string | null }>]
  const post = rows[0]
  if (!post) throw new HttpError(404, 'not_found')
  if (post.deleted_at !== null && ctx.role === 'viewer') {
    throw new HttpError(404, 'not_found')
  }

  return new Response(JSON.stringify({ post }), {
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
  checkMutationRate(ctx.userId)

  const raw = await readJsonBody(req)
  const Schema = ctx.role === 'admin' ? AdminSchema : EditorSchema
  const meta = auditMetaFromRequest(req)

  let body: Body
  try {
    body = Schema.parse(raw) as Body
  } catch (e) {
    // RBAC visibility audit: if an editor sent admin-only fields,
    // log the rejection (key names only, never values) before 403.
    if (ctx.role === 'editor' && raw && typeof raw === 'object') {
      const adminOnly = new Set<string>(ADMIN_ONLY_COLS.map(([k]) => k))
      const offending = Object.keys(raw as Record<string, unknown>).filter(
        (k) => adminOnly.has(k),
      )
      if (offending.length > 0) {
        await db.insert(auditLog).values({
          userId: ctx.userId,
          action: 'rbac_field_reject',
          resourceType: 'post',
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
    } else if (ctx.role === 'editor') {
      // Non-object editor payloads (string, array, scalar) are an
      // exotic probe that bypasses the object-keys check above.
      // Log the shape (typeof only — never the value) so forensic
      // triage can correlate. Best-effort INSERT: if the audit
      // write itself errors, swallow so the original ZodError
      // still propagates as a 400. Without `.catch` an audit-log
      // DB blip would convert client error to server error.
      await db
        .insert(auditLog)
        .values({
          userId: ctx.userId,
          action: 'rbac_field_reject',
          resourceType: 'post',
          resourceId: String(id),
          diff: {
            kind: AUDIT_KIND.rbacFieldReject,
            shape: typeof raw,
          } as unknown as object,
          ip: meta.ip,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        })
        .catch(() => {})
    }
    throw e
  }

  // slugChangedOuter lifted so the catch block can gate the dup-key
  // translation: only an attempted slug rename should map ER_DUP_ENTRY
  // → slug_taken. Other unique-index races (slug_redirects collisions,
  // future uniques) surface as a generic 409 conflict — keeps audit
  // triage honest.
  let slugChangedOuter = false
  try {
    const txResult = await db.transaction(async (tx) => {
      const [rows] = (await tx.execute(sql`
        SELECT id, slug, title, excerpt, body_md, hero_image_id,
               seo_title, seo_description, og_image_id,
               focus_keyphrase, robots_noindex, robots_nofollow,
               canonical_url, cornerstone, seo_score, readability_score,
               seo_meta,
               published, version
        FROM posts
        WHERE id = ${id} AND deleted_at IS NULL
        FOR UPDATE
      `)) as unknown as [PostRow[]]
      const row = rows[0]
      if (!row) throw new HttpError(404, 'not_found')
      if (row.version !== body.version) {
        throw new HttpError(409, 'stale_version')
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

      // Slug rename: insert/upsert redirect → collapse chain → drop
      // self-reference. Three statements inside the TX so a crash
      // mid-rename never leaves a half-built redirect map. The
      // resource_type='post' rows share the slug_redirects table
      // with projects via the (resource_type, old_slug) unique
      // index, so there's no cross-entity collision.
      //
      // Pre-lock every slug_redirects row this block could touch so
      // a concurrent cross-rename (A→B and C→A at once) can't have
      // its DELETE step clobber the other's freshly-inserted row.
      // Without this lock, two TXes could each see their own pre-
      // image and end up with one redirect missing. The pre-SELECT
      // grabs X-locks on (old_slug=row.slug, old_slug=body.slug,
      // new_slug=row.slug) so the other TX serializes behind us.
      if (slugChanged && body.slug) {
        await tx.execute(sql`
          SELECT id FROM slug_redirects
          WHERE resource_type = 'post'
            AND (old_slug = ${row.slug}
                 OR old_slug = ${body.slug}
                 OR new_slug = ${row.slug})
          FOR UPDATE
        `)
        await tx.execute(sql`
          INSERT INTO slug_redirects (resource_type, old_slug, new_slug)
          VALUES ('post', ${row.slug}, ${body.slug})
          ON DUPLICATE KEY UPDATE new_slug = VALUES(new_slug)
        `)
        await tx.execute(sql`
          UPDATE slug_redirects
          SET new_slug = ${body.slug}
          WHERE resource_type = 'post' AND new_slug = ${row.slug}
        `)
        await tx.execute(sql`
          DELETE FROM slug_redirects
          WHERE resource_type = 'post' AND old_slug = ${body.slug}
        `)
      }

      const { setSql, applied } = buildSets(
        body,
        row,
        ctx.role,
        ctx.userId,
        publishedTransition,
      )

      // coreChanged: any field that influences /blog index render.
      // Excerpt is shown on the index card; title is the link text;
      // heroImageId would feed a future thumbnail. Body_md changes
      // affect only the detail page — those land via the post-slug
      // tag below without invalidating the whole index.
      const coreChanged =
        applied.title !== undefined ||
        applied.excerpt !== undefined ||
        applied.heroImageId !== undefined

      // No-op short-circuit. If nothing actually changed AND no
      // version-affecting side effects are needed, return the
      // current version untouched — idempotent client retries hit
      // this path on the second attempt.
      const nothingApplied = Object.keys(applied).length === 0
      if (
        nothingApplied &&
        publishedTransition === 'none' &&
        !slugChanged
      ) {
        return {
          newVersion: row.version,
          queueRowId: null as number | null,
          tags: [] as string[],
          indexNowPath: null as string | null,
        }
      }

      await tx.execute(sql`UPDATE posts SET ${setSql} WHERE id = ${id}`)

      // Reconcile media_references for hero_image_id + og_image_id.
      // The column stores the id; the reference must also live in
      // media_references so the media DELETE refuses while any post
      // still points at the row.
      const MEDIA_COLS: Array<[
        keyof typeof applied,
        'hero_image_id' | 'og_image_id',
        number | null,
      ]> = [
        ['heroImageId', 'hero_image_id', row.hero_image_id],
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
              AND referent_type = 'post'
              AND referent_id = ${id}
              AND field = ${column}
          `)
        }
        if (newVal !== null) {
          newMediaIds.push(newVal)
          await tx.execute(sql`
            INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
            VALUES (${newVal}, 'post', ${id}, ${column})
          `)
        }
      }
      if (newMediaIds.length > 0) {
        await assertMediaAvailable(tx, newMediaIds)
      }

      // Audit `from` mirrors every editable column so forensic
      // triage can reconstruct the prior value of ANY field the
      // PATCH touched. body_md is replaced with a (sha256, length)
      // fingerprint so the audit row stays bounded even when the
      // post body is 100KB+ — a fast typist hammering save would
      // otherwise inflate audit_log retention quickly.
      const prevBodyMdSha256 = createHash('sha256')
        .update(row.body_md)
        .digest('hex')
      const prevBodyMdLen = Buffer.byteLength(row.body_md, 'utf8')
      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'update',
        resourceType: 'post',
        resourceId: String(id),
        diff: {
          kind: AUDIT_KIND.patch,
          from: {
            slug: row.slug,
            title: row.title,
            excerpt: row.excerpt,
            body_md_sha256: prevBodyMdSha256,
            body_md_len: prevBodyMdLen,
            hero_image_id: row.hero_image_id,
            seo_title: row.seo_title,
            seo_description: row.seo_description,
            og_image_id: row.og_image_id,
            focus_keyphrase: row.focus_keyphrase,
            robots_noindex: row.robots_noindex === 1,
            robots_nofollow: row.robots_nofollow === 1,
            canonical_url: row.canonical_url,
            cornerstone: row.cornerstone === 1,
            seo_score: row.seo_score,
            readability_score: row.readability_score,
            published: row.published === 1,
            // seo_meta intentionally omitted from the audit `from` — the
            // raw JSON blob can be large + the `to` map already records
            // the new value; forensic triage reads the prior value from
            // the previous audit row's `to`. Mirrors the body_md
            // fingerprint rationale above (bound audit payload).
            // published_at not selected by the FOR UPDATE query;
            // forensic triage that needs the prior timestamp pulls
            // it from a previous audit row's `to` block or from
            // the (rare) backups. Storing it here would require an
            // extra SELECT column for a low-value forensic signal.
          },
          to: applied,
          slugChanged,
          publishedTransition,
          // coreChanged drives index cache invalidation; record so
          // forensic triage can correlate a stale-index report
          // against the exact save that should have busted it.
          coreChanged,
        } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })

      const newSlug = body.slug ?? row.slug
      // tagsForPostSave now owns the old-slug invalidation (page tag
      // AND admin-bar slug-resolver tag) — pass the pre-rename slug
      // when slugChanged so a single source of truth handles both
      // fresh and stale caches.
      const tagSet = tagsForPostSave(newSlug, {
        publishedChanged,
        slugChanged,
        oldSlug: slugChanged ? row.slug : undefined,
        coreChanged,
      }).tags

      const queueRowId = await enqueueRevalidate(tx, tagSet)

      // IndexNow: announce the post's public URL when this save leaves it
      // LIVE — on a publish transition, or any content edit while already
      // published (we're past the no-op short-circuit here, so a real
      // change happened). Never on draft saves (post not published) or on
      // unpublish (publishedTransition === 'off'). The path is built from
      // the post-rename slug; computed here, pinged after the TX commits.
      const finalPublished =
        publishedTransition === 'on' ||
        (row.published === 1 && publishedTransition !== 'off')
      // Never ping a noindexed post — IndexNow announcing a URL the
      // sitemap excludes (excludeNoindex) is a contradictory crawl
      // signal. Final noindex state = applied delta when this PATCH
      // changed it, else the loaded row value.
      const finalNoindex =
        applied.robotsNoindex !== undefined
          ? applied.robotsNoindex
          : row.robots_noindex === 1
      return {
        newVersion: row.version + 1,
        queueRowId,
        tags: tagSet,
        indexNowPath:
          finalPublished && !finalNoindex
            ? `/blog/${newSlug}`
            : (null as string | null),
      }
    })

    if (txResult.queueRowId !== null) {
      const rowId = txResult.queueRowId
      const tags = txResult.tags
      queueMicrotask(() => {
        void drainRevalidate(rowId, tags)
      })
    }

    // Fire-and-forget IndexNow ping — never awaited, never throws, never
    // blocks the save response (the standalone server is long-lived).
    if (txResult.indexNowPath !== null) {
      void notifyIndexNow([txResult.indexNowPath])
    }

    return new Response(
      JSON.stringify({ ok: true, version: txResult.newVersion }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'private, no-store',
        },
      },
    )
  } catch (err: unknown) {
    if (isDuplicateKey(err)) {
      throw new HttpError(409, slugChangedOuter ? 'slug_taken' : 'conflict')
    }
    throw err
  }
})

// Soft delete. Admin-only. The row stays in the table until a
// future cron purge hard-removes it; until then the /blog routes
// filter on deleted_at IS NULL.
export const DELETE = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const meta = auditMetaFromRequest(req)

  const txResult = await db.transaction(async (tx) => {
    const [rows] = (await tx.execute(sql`
      SELECT id, slug FROM posts
      WHERE id = ${id} AND deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [Array<{ id: number; slug: string }>]
    const row = rows[0]
    if (!row) throw new HttpError(404, 'not_found')

    await tx.execute(sql`
      UPDATE posts
      SET deleted_at = NOW(3),
          updated_by = ${ctx.userId}
      WHERE id = ${id}
    `)

    // Clean any slug_redirects pointing AT this post so a renamed-
    // then-deleted post doesn't leave dangling 308→404 cascades for
    // crawlers hitting the old URL. We drop both directions of the
    // map: rows that USED to redirect to this slug, and any row
    // that lists this slug as new (which shouldn't exist if the
    // chain-collapse step worked, but is safe to clean either way).
    await tx.execute(sql`
      DELETE FROM slug_redirects
      WHERE resource_type = 'post'
        AND (new_slug = ${row.slug} OR old_slug = ${row.slug})
    `)

    await tx.insert(auditLog).values({
      userId: ctx.userId,
      action: 'delete',
      resourceType: 'post',
      resourceId: String(id),
      diff: { kind: AUDIT_KIND.delete, slug: row.slug } as unknown as object,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })

    // Route through the centralised tag helper so the bar's
    // slug-resolver tag is always invalidated (was previously dropped
    // by the hand-rolled array — the security audit caught it).
    const tags = tagsForPostDelete(row.slug).tags
    const queueRowId = await enqueueRevalidate(tx, tags)
    return { queueRowId, tags }
  })

  queueMicrotask(() => {
    void drainRevalidate(txResult.queueRowId, txResult.tags)
  })

  return new Response(null, { status: 204 })
})

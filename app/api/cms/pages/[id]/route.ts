import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate, checkReadRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { isDuplicateKey } from '@/lib/db/errors'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import {
  tag,
  tagsForPageSave,
  tagsForPageDelete,
} from '@/lib/cache/tags'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { assertMediaAvailable } from '@/lib/cms/mediaCheck'
import { PageEditorPatch, PageAdminPatch } from '@/lib/cms/page-shapes'
import { validatePageSlug } from '@/lib/cms/page-slug'
import type { PageRawRow } from '@/lib/cms/types'
import { env } from '@/lib/env'

const ID_PATTERN = /^[1-9][0-9]{0,9}$/

function parseId(raw: string): number {
  if (!ID_PATTERN.test(raw)) throw new HttpError(400, 'invalid_id')
  return Number(raw)
}

type RouteCtx = { params: Promise<{ id: string }> }

// Editor + admin allowlists kept in sync with lib/cms/page-shapes.ts.
// The keys here are the public Zod field names; the dynamic UPDATE SET
// branch maps them to snake_case DB columns inline.
const EDITOR_FIELDS = [
  'title',
  'seoTitle',
  'seoDescription',
  'heroImageId',
  'ogImageId',
] as const
const ADMIN_ONLY_FIELDS = ['slug', 'published', 'isHome'] as const

type EditorField = (typeof EDITOR_FIELDS)[number]

interface BlockListRow {
  id: number
  block_key: string | null
  block_type: string
  position: number
  data: string
  version: number
}

// ─── GET /api/cms/pages/[id] — single page + blocks for editor load ──
export const GET = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin', 'editor', 'viewer'])
  checkReadRate(ctx.userId)

  const [pageRows] = (await db.execute(sql`
    SELECT * FROM pages WHERE id = ${id}
  `)) as unknown as [PageRawRow[]]
  const page = pageRows[0]
  if (!page) throw new HttpError(404, 'not_found')

  // Trashed rows are admin + editor only (matches the trash-view
  // surface in /admin/pages?trashed=1). Viewer reading a trashed
  // row should be indistinguishable from the row not existing —
  // 404 not_found, no oracle for "trashed page exists at this id".
  if (page.deleted_at !== null && ctx.role === 'viewer') {
    throw new HttpError(404, 'not_found')
  }

  // Soft-deleted rows are visible via this endpoint so the trash UI
  // can deep-link into a row's metadata for a preview before restore.
  // The PATCH/DELETE handlers each re-check deleted_at status under
  // FOR UPDATE so a mutation never lands on a stale view.

  const [blockRows] = (await db.execute(sql`
    SELECT id, block_key, block_type, position, data, version
    FROM content_blocks
    WHERE page_id = ${id} AND deleted_at IS NULL
    ORDER BY position
  `)) as unknown as [BlockListRow[]]

  return new Response(JSON.stringify({ page, blocks: blockRows }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})

// ─── PATCH /api/cms/pages/[id] — page-level field update ─────────────
// Full 12-step TX per spec §4.3. Editor schema (no slug/published/isHome)
// vs admin schema is selected by ctx.role; any unknown key in either
// schema trips .strict() rejection. RBAC-field-reject audit fires when
// an editor attempts an admin-only field.
export const PATCH = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const raw = await readJsonBody(req)
  const Schema = ctx.role === 'admin' ? PageAdminPatch : PageEditorPatch
  const meta = auditMetaFromRequest(req)

  let body: {
    title?: string
    seoTitle?: string | null
    seoDescription?: string | null
    heroImageId?: number | null
    ogImageId?: number | null
    version: number
    slug?: string
    published?: boolean
    isHome?: boolean
  }
  try {
    body = Schema.parse(raw) as typeof body
  } catch (e) {
    if (ctx.role === 'editor' && raw && typeof raw === 'object') {
      const adminOnly = new Set<string>(ADMIN_ONLY_FIELDS)
      const offending = Object.keys(raw as Record<string, unknown>).filter(
        (k) => adminOnly.has(k),
      )
      if (offending.length > 0) {
        await db.insert(auditLog).values({
          userId: ctx.userId,
          action: 'rbac_field_reject',
          resourceType: 'page',
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
      // Non-object editor payload — best-effort audit (typeof only).
      await db
        .insert(auditLog)
        .values({
          userId: ctx.userId,
          action: 'rbac_field_reject',
          resourceType: 'page',
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

  // `slugChangedOuter` lifted so the catch block can disambiguate the
  // dup-key translation: ER_DUP_ENTRY on `idx_pages_slug` → slug_in_use;
  // on `idx_pages_is_home_unique` → home_race_retry; other unique
  // races → generic 409 conflict. Detection is by constraint name in
  // err.message so future schema additions get distinct mapping.
  let slugChangedOuter = false
  let isHomeFlipOuter = false

  try {
    const txResult = await db.transaction(async (tx) => {
      // Step 1: lock the row.
      const [rows] = (await tx.execute(sql`
        SELECT * FROM pages
        WHERE id = ${id} AND deleted_at IS NULL
        FOR UPDATE
      `)) as unknown as [PageRawRow[]]
      const row = rows[0]
      if (!row) throw new HttpError(404, 'not_found')

      // Step 2: optimistic-lock check.
      if (row.version !== body.version) {
        throw new HttpError(409, 'stale_version')
      }

      // Step 3: slug rename branch.
      const slugChanged =
        ctx.role === 'admin' &&
        body.slug !== undefined &&
        body.slug !== row.slug
      slugChangedOuter = slugChanged

      if (slugChanged && body.slug !== undefined) {
        // System rows are immutable on slug — UNLESS the row is the
        // home row (is_home=1). The home row CAN rename for SEO; its
        // `/` URL stays via the url_path generated column regardless.
        // Non-home system rows (about/services/contact) refuse rename.
        if (row.system === 1 && row.is_home === 0) {
          throw new HttpError(409, 'system_slug_locked')
        }

        // Validate the new slug (NFKC + ASCII + RESERVED + LOGIN_PATH).
        const slugCheck = validatePageSlug(body.slug, env.LOGIN_PATH)
        if (!slugCheck.ok) {
          console.info(
            JSON.stringify({
              level: 'info',
              msg: 'slug_validation_failed',
              reason: slugCheck.reason,
              candidate: body.slug,
            }),
          )
          throw new HttpError(422, 'slug_invalid')
        }

        // Also validate the row's CURRENT slug (the redirect's old_slug
        // end). Spec §4.3 step 3: "Validate BOTH ends of every redirect
        // write against reserved set + LOGIN_PATH" — refuse the write
        // if either end matches RESERVED or LOGIN_PATH. The current
        // slug normally already passes (it was validated at row-create
        // or last-rename time) but a LOGIN_PATH env rotation between
        // those events and this rename could leave it now-reserved;
        // writing it as old_slug would let an operator-typed
        // /{LOGIN_PATH} request match a slug_redirects row and bypass
        // the public-route reserved-set defence. Same `slug_invalid`
        // public code as the new-slug failure (spec §5.2).
        const oldSlugCheck = validatePageSlug(row.slug, env.LOGIN_PATH)
        if (!oldSlugCheck.ok) {
          console.info(
            JSON.stringify({
              level: 'info',
              msg: 'slug_validation_failed',
              reason: oldSlugCheck.reason,
              candidate: row.slug,
              context: 'patch_rename_old_slug',
            }),
          )
          throw new HttpError(422, 'slug_invalid')
        }

        // Pre-lock target row owning the new slug (if any) so the
        // concurrent-rename race is serialised behind us.
        await tx.execute(sql`
          SELECT id FROM pages
          WHERE slug = ${body.slug} AND deleted_at IS NULL
          FOR UPDATE
        `)

        // Pre-lock every slug_redirects row touching either slug, in
        // deterministic id order. The new idx_slug_redirects_type_old
        // unique index from §1.4 step 9 enforces (resource_type, old_slug)
        // uniqueness; the ORDER BY is defence-in-depth for predictable
        // deadlock behaviour under concurrent cross-renames.
        await tx.execute(sql`
          SELECT id FROM slug_redirects
          WHERE resource_type = 'page'
            AND (old_slug = ${row.slug}
                 OR old_slug = ${body.slug}
                 OR new_slug = ${row.slug}
                 OR new_slug = ${body.slug})
          ORDER BY id ASC
          FOR UPDATE
        `)

        // Cross-resource collision check: refuse if a different
        // resource_type already owns the same old_slug. Surfaces as
        // 409 slug_redirect_collision (distinct from slug_in_use).
        const [crossType] = (await tx.execute(sql`
          SELECT 1 FROM slug_redirects
          WHERE old_slug = ${row.slug}
            AND resource_type != 'page'
          LIMIT 1
        `)) as unknown as [Array<{ '1': number }>]
        if (crossType.length > 0) {
          throw new HttpError(409, 'slug_redirect_collision')
        }

        // 3-statement redirect block (verbatim posts pattern):
        //   (a) upsert (resource_type='page', old_slug, new_slug)
        //   (b) collapse chains: any row whose new_slug matches the
        //       PRIOR slug updates to point at the new slug instead.
        //       A→B then rename B→C becomes A→C and B→C.
        //   (c) drop the (new_slug → new_slug) self-reference that
        //       collapse could have produced.
        await tx.execute(sql`
          INSERT INTO slug_redirects (resource_type, old_slug, new_slug)
          VALUES ('page', ${row.slug}, ${body.slug})
          ON DUPLICATE KEY UPDATE new_slug = VALUES(new_slug)
        `)
        await tx.execute(sql`
          UPDATE slug_redirects
          SET new_slug = ${body.slug}
          WHERE resource_type = 'page' AND new_slug = ${row.slug}
        `)
        await tx.execute(sql`
          DELETE FROM slug_redirects
          WHERE resource_type = 'page' AND old_slug = ${body.slug}
        `)
      }

      // Step 4 / 5: is_home transitions.
      const wantsHomeTrue =
        ctx.role === 'admin' && body.isHome === true && row.is_home === 0
      const wantsHomeFalse =
        ctx.role === 'admin' && body.isHome === false && row.is_home === 1
      const isHomeChanged = wantsHomeTrue || wantsHomeFalse
      isHomeFlipOuter = wantsHomeTrue

      if (wantsHomeFalse) {
        // Refuse — operator must set ANOTHER row as home first.
        throw new HttpError(409, 'cannot_unset_home')
      }

      let priorHomeSlug: string | null = null
      if (wantsHomeTrue) {
        // Compute currentHomeId (non-locking). Under concurrent
        // soft-delete this value may be stale — that's OK: the
        // load-bearing guarantee is the partial unique constraint
        // `idx_pages_is_home_unique`. The deterministic lock order
        // below is purely deadlock-prevention against saveBlock /
        // §4.4 soft-delete which ALSO lock `pages` rows. Filter on
        // `deleted_at IS NULL` so a legacy pre-rev-4 trashed-but-
        // is_home=1 row doesn't widen the lock footprint (defence
        // against the legacy-data note in §4.5 step 4).
        const [homeRows] = (await tx.execute(sql`
          SELECT id FROM pages
          WHERE is_home = 1 AND deleted_at IS NULL
          LIMIT 1
        `)) as unknown as [Array<{ id: number }>]
        const currentHomeId = homeRows[0]?.id

        if (currentHomeId !== undefined && currentHomeId !== id) {
          // Lock both rows in deterministic ASC-by-id order AND
          // capture the prior home's slug. Per spec §2.9 the home
          // flip invalidates BOTH involved rows' `tag.page(slug)` +
          // `tag.pageSlugResolver(slug)` tags (because each row's
          // `url_path` recomputes on the flip — old home becomes
          // `/{slug}`, new home becomes `/`). Without capturing the
          // prior slug here, the post-commit revalidate set would
          // miss the prior home's cache entries until they TTL.
          const [lockedRows] = (await tx.execute(sql`
            SELECT id, slug FROM pages
            WHERE id IN (${id}, ${currentHomeId})
            ORDER BY id ASC
            FOR UPDATE
          `)) as unknown as [Array<{ id: number; slug: string }>]
          for (const r of lockedRows) {
            if (r.id === currentHomeId) priorHomeSlug = r.slug
          }
          // Clear the prior home — triggers its url_path recompute to
          // `/{slug}`. May affect 0 rows if currentHomeId was stale;
          // harmless, the next UPDATE still sets the new home.
          await tx.execute(sql`
            UPDATE pages
            SET is_home = 0
            WHERE is_home = 1 AND id != ${id}
          `)
        }
        // Setting is_home=1 on the target row happens via the dynamic
        // SET below (so it lands inside the same UPDATE as the other
        // edited fields + version bump + preview_epoch bump). The
        // is_home=1 write triggers url_path recompute to `/`. The
        // idx_pages_is_home_unique constraint will reject a concurrent
        // double-flip with ER_DUP_ENTRY on that index name — caught and
        // mapped to 409 home_race_retry below.
      }

      // Step 6: publish transition.
      const publishedTransition: 'on' | 'off' | 'none' =
        ctx.role === 'admin' && body.published !== undefined
          ? (body.published ? 1 : 0) === row.published
            ? 'none'
            : body.published
              ? 'on'
              : 'off'
          : 'none'
      const publishedChanged = publishedTransition !== 'none'

      // Step 7: preview_epoch bump. Slug rename / unpublish / is_home
      // flip / soft-delete all bump the epoch so any leaked preview
      // token invalidates instantly.
      const bumpEpoch =
        slugChanged ||
        publishedTransition === 'off' ||
        isHomeChanged

      // Step 8 + 9: build the dynamic SET. Column allowlist keeps
      // raw-SQL interpolation safe; every value is parameterized.
      const parts: ReturnType<typeof sql>[] = [
        sql`version = version + 1`,
        sql`updated_by = ${ctx.userId}`,
      ]
      const applied: Record<string, unknown> = {}

      if (publishedTransition === 'on') {
        parts.push(sql`published_at = COALESCE(published_at, NOW(3))`)
      }
      if (bumpEpoch) {
        parts.push(sql`preview_epoch = preview_epoch + 1`)
      }

      // Editor-visible fields. Map camelCase Zod key → snake_case column.
      const EDITOR_MAP: Record<EditorField, { col: string; rowKey: keyof PageRawRow }> = {
        title: { col: 'title', rowKey: 'title' },
        seoTitle: { col: 'seo_title', rowKey: 'seo_title' },
        seoDescription: { col: 'seo_description', rowKey: 'seo_description' },
        heroImageId: { col: 'hero_image_id', rowKey: 'hero_image_id' },
        ogImageId: { col: 'og_image_id', rowKey: 'og_image_id' },
      }
      for (const field of EDITOR_FIELDS) {
        const v = body[field as keyof typeof body]
        if (v === undefined) continue
        const { col, rowKey } = EDITOR_MAP[field]
        const rowVal = row[rowKey] as unknown
        if (v === rowVal) continue
        parts.push(sql`${sql.raw(col)} = ${v as string | number | null}`)
        applied[field] = v
      }

      if (ctx.role === 'admin') {
        if (body.slug !== undefined && slugChanged) {
          parts.push(sql`slug = ${body.slug}`)
          applied['slug'] = body.slug
        }
        if (body.published !== undefined && publishedChanged) {
          parts.push(sql`published = ${body.published ? 1 : 0}`)
          applied['published'] = body.published
        }
        if (wantsHomeTrue) {
          parts.push(sql`is_home = 1`)
          applied['isHome'] = true
        }
      }

      // No-op short-circuit. If nothing changed AND no version-affecting
      // side effect is needed, return the current version untouched —
      // idempotent client retries hit this path on the second attempt.
      //
      // Forensic note: an editor-role probe `PATCH { version: N }` with
      // no fields lands here too, returning the current `version`
      // unchanged. This is technically a version-enumeration oracle
      // (editor can iterate N=0,1,2,... to find the live version) BUT
      // editors ALREADY have GET access to the same value via
      // `GET /api/cms/pages/[id]`, so the leak is not novel. We still
      // write an audit row for editor-role no-ops so forensic triage
      // can correlate any subsequent action against the probe footprint.
      // Admin no-ops stay silent (legitimate idempotent retry pattern).
      const nothingApplied = Object.keys(applied).length === 0
      if (
        nothingApplied &&
        publishedTransition === 'none' &&
        !slugChanged &&
        !isHomeChanged
      ) {
        if (ctx.role === 'editor') {
          await tx
            .insert(auditLog)
            .values({
              userId: ctx.userId,
              action: 'rbac_field_reject',
              resourceType: 'page',
              resourceId: String(id),
              diff: {
                kind: AUDIT_KIND.rbacFieldReject,
                keys: ['__noop_probe'],
              } as unknown as object,
              ip: meta.ip,
              userAgent: meta.userAgent,
              requestId: meta.requestId,
            })
            .catch(() => {
              // Audit insert failure shouldn't escalate a benign no-op
              // PATCH into a 500; the legitimate-blur path expects 200.
            })
        }
        return {
          newVersion: row.version,
          queueRowId: null as number | null,
          tags: [] as string[],
        }
      }

      const setSql = sql.join(parts, sql`, `)
      await tx.execute(sql`UPDATE pages SET ${setSql} WHERE id = ${id}`)

      // Step 10: reconcile media_references for hero + og.
      const MEDIA_COLS: Array<[
        'heroImageId' | 'ogImageId',
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
              AND referent_type = 'page'
              AND referent_id = ${id}
              AND field = ${column}
          `)
        }
        if (newVal !== null) {
          newMediaIds.push(newVal)
          await tx.execute(sql`
            INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
            VALUES (${newVal}, 'page', ${id}, ${column})
          `)
        }
      }
      if (newMediaIds.length > 0) {
        await assertMediaAvailable(tx, newMediaIds)
      }

      // Step 11: audit row.
      const coreChanged =
        applied['title'] !== undefined ||
        applied['heroImageId'] !== undefined
      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'update',
        resourceType: 'page',
        resourceId: String(id),
        diff: {
          kind: AUDIT_KIND.patch,
          from: {
            slug: row.slug,
            title: row.title,
            seo_title: row.seo_title,
            seo_description: row.seo_description,
            hero_image_id: row.hero_image_id,
            og_image_id: row.og_image_id,
            published: row.published === 1,
            is_home: row.is_home === 1,
            preview_epoch: row.preview_epoch,
          },
          to: applied,
          slugChanged,
          publishedTransition,
          isHomeChanged,
          coreChanged,
          ...(slugChanged
            ? { oldSlug: row.slug, newSlug: body.slug ?? row.slug }
            : {}),
        } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })

      // Step 12: enqueue revalidate. The pages-CMS coreChanged set
      // additionally fires on SEO + OG-image edits (§2.9 matrix's
      // "PATCH title / SEO / hero only" row) — without this, an
      // operator SEO edit doesn't refresh the admin list's
      // `updated_at` timestamp.
      const coreChangedFull =
        coreChanged ||
        applied['seoTitle'] !== undefined ||
        applied['seoDescription'] !== undefined ||
        applied['ogImageId'] !== undefined
      const newSlug = body.slug ?? row.slug
      const tagSet = tagsForPageSave(newSlug, {
        publishedChanged,
        slugChanged,
        coreChanged: coreChangedFull,
        isHomeChanged,
        wasHome: row.is_home === 1,
        isHome: wantsHomeTrue || (row.is_home === 1 && !wantsHomeFalse),
        oldSlug: slugChanged ? row.slug : null,
      }).tags
      // Home-flip invalidation (spec §2.9): both involved rows'
      // `tag.page(slug)` + `tag.pageSlugResolver(slug)` must fire
      // because BOTH rows' `url_path` recomputes (old home → `/{slug}`;
      // new home → `/`). `tagsForPageSave` knows only the NEW home's
      // slug; append the prior home's tags explicitly when present.
      if (priorHomeSlug && priorHomeSlug !== newSlug) {
        tagSet.push(tag.page(priorHomeSlug), tag.pageSlugResolver(priorHomeSlug))
      }
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
    if (err instanceof HttpError) throw err
    if (isDuplicateKey(err)) {
      // Distinguish constraint by name. `idx_pages_is_home_unique` is
      // the partial unique on the generated `is_home_key` column;
      // `idx_pages_slug` is the slug UNIQUE. Other future unique
      // indexes fall through to a generic 409 conflict.
      const msg =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message: unknown }).message)
          : ''
      const sqlMsg =
        err && typeof err === 'object' && 'sqlMessage' in err
          ? String((err as { sqlMessage: unknown }).sqlMessage)
          : ''
      const haystack = `${msg} ${sqlMsg}`
      // Check by explicit constraint name FIRST so a combined slug+home
      // race (PATCH changes both fields) gets the right code regardless
      // of which constraint actually tripped. Driver-name match wins
      // before the fallback heuristics.
      if (haystack.includes('idx_pages_is_home_unique')) {
        throw new HttpError(409, 'home_race_retry')
      }
      if (haystack.includes('idx_pages_slug')) {
        throw new HttpError(409, 'slug_in_use')
      }
      // Driver omitted the constraint name from both error fields.
      // Fall back to the operation-intent flags: is_home flip wins over
      // slug rename because the partial-unique constraint is the more
      // surprising failure (slug collisions almost always surface as
      // idx_pages_slug in mysql2's err.message; is_home races are
      // narrower). Either way we surface a 409, just with the most
      // operator-actionable code.
      if (isHomeFlipOuter) throw new HttpError(409, 'home_race_retry')
      if (slugChangedOuter) throw new HttpError(409, 'slug_in_use')
      throw new HttpError(409, 'conflict')
    }
    throw err
  }
})

// ─── DELETE /api/cms/pages/[id] — soft delete ────────────────────────
// Admin-only. 5-step TX per spec §4.4 with
// cut-leaf-only slug_redirects cleanup (diverges from posts/projects'
// cleanup-both-directions per rev-3 → rev-4 operator decision).
export const DELETE = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const meta = auditMetaFromRequest(req)

  const txResult = await db.transaction(async (tx) => {
    // Step 1: lock + read. Capture wasHome + wasSlug from THIS result
    // BEFORE the UPDATE clears is_home (§4.4 step 1 explicit-binding).
    const [rows] = (await tx.execute(sql`
      SELECT id, slug, title, is_home
      FROM pages
      WHERE id = ${id} AND deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [
      Array<{ id: number; slug: string; title: string; is_home: number }>,
    ]
    const row = rows[0]
    if (!row) throw new HttpError(404, 'not_found')
    const wasHome = row.is_home === 1
    const wasSlug = row.slug

    // Step 2: soft-delete + clear is_home + bump preview_epoch in ONE
    // UPDATE. `is_home` MUST clear here otherwise a §4.5 restore would
    // resurrect a row alongside the current home and violate the
    // partial-unique constraint on idx_pages_is_home_unique. The
    // url_path generated column auto-recomputes from `/` → `/{slug}`.
    await tx.execute(sql`
      UPDATE pages
      SET deleted_at = NOW(3),
          is_home = 0,
          preview_epoch = preview_epoch + 1,
          updated_by = ${ctx.userId}
      WHERE id = ${id}
    `)

    // Step 3: slug_redirects CUT-LEAF ONLY. Delete rows where
    // new_slug = wasSlug (chains pointing AT the deleted row's slug).
    // Do NOT delete rows where old_slug = wasSlug — preserve rename
    // history pointing AT the deleted slug per §4.4 step 3. Diverges
    // from posts/projects cleanup-both-directions; documented in §13.
    await tx.execute(sql`
      DELETE FROM slug_redirects
      WHERE resource_type = 'page' AND new_slug = ${wasSlug}
    `)

    // Step 4: audit.
    await tx.insert(auditLog).values({
      userId: ctx.userId,
      action: 'delete',
      resourceType: 'page',
      resourceId: String(id),
      diff: {
        kind: AUDIT_KIND.delete,
        slug: wasSlug,
        title: row.title,
        is_home: wasHome,
      } as unknown as object,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })

    // Step 5: revalidate.
    const tags = tagsForPageDelete(wasSlug, { wasHome }).tags
    const queueRowId = await enqueueRevalidate(tx, tags)
    return { queueRowId, tags }
  })

  queueMicrotask(() => {
    void drainRevalidate(txResult.queueRowId, txResult.tags)
  })

  return new Response(null, { status: 204 })
})

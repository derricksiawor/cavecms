import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkCmsMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { isDuplicateKey } from '@/lib/db/errors'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import { tagsForPageRestore } from '@/lib/cache/tags'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { RestorePageBody } from '@/lib/cms/page-shapes'
import { validatePageSlug } from '@/lib/cms/page-slug'
import { env } from '@/lib/env'

// POST /api/cms/pages/[id]/restore — restore from trash. Admin only.
// Per spec §4.5. Restored rows ALWAYS land as draft (`published=0`,
// `published_at=NULL`, `is_home=0`) so an operator must explicitly
// re-publish AND re-set-home if needed.

const ID_PATTERN = /^[1-9][0-9]{0,9}$/
function parseId(raw: string): number {
  if (!ID_PATTERN.test(raw)) throw new HttpError(400, 'invalid_id')
  return Number(raw)
}

type RouteCtx = { params: Promise<{ id: string }> }

export const POST = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'pages', 'write')
  checkCmsMutationRate(ctx)

  // Empty body is permitted (restores under original slug). asSlug
  // overrides when the original slug has been stolen by another live
  // row while this row sat in trash.
  let raw: unknown = {}
  try {
    raw = await readJsonBody(req)
  } catch {
    raw = {}
  }
  const body = RestorePageBody.parse(raw ?? {})
  const meta = auditMetaFromRequest(req)

  try {
    const txResult = await db.transaction(async (tx) => {
      // Step 1: lock + read. Filter on 30-day retention window —
      // anything past that has already been hard-purged or is about to
      // be (cron-purge.ts in PR-4 owns the actual DELETE). Treating a
      // past-retention row as 404 here keeps the API contract clean
      // even if a single cron run is briefly skipped.
      const [rows] = (await tx.execute(sql`
        SELECT id, slug, version, is_home
        FROM pages
        WHERE id = ${id}
          AND deleted_at IS NOT NULL
          AND deleted_at > NOW(3) - INTERVAL 30 DAY
        FOR UPDATE
      `)) as unknown as [
        Array<{ id: number; slug: string; version: number; is_home: number }>,
      ]
      const row = rows[0]
      if (!row) throw new HttpError(404, 'not_found')

      const originalSlug = row.slug
      const targetSlug = body.asSlug ?? originalSlug
      const renamed = targetSlug !== originalSlug

      // Step 2: validate the target slug. Both `asSlug` (operator-
      // supplied) AND the original slug are run through validatePageSlug —
      // defence against a bulk-import that brought in a row with a
      // since-reserved slug (§4.5 step 5 mandates BOTH-end validation
      // before any slug_redirects write).
      const targetCheck = validatePageSlug(targetSlug, env.LOGIN_PATH)
      if (!targetCheck.ok) {
        console.info(
          JSON.stringify({
            level: 'info',
            msg: 'slug_validation_failed',
            reason: targetCheck.reason,
            candidate: targetSlug,
          }),
        )
        throw new HttpError(422, 'slug_invalid')
      }
      if (renamed) {
        const originalCheck = validatePageSlug(originalSlug, env.LOGIN_PATH)
        if (!originalCheck.ok) {
          // The original slug is no longer valid (LOGIN_PATH rotated
          // into it, or a future RESERVED entry collided). Surface
          // generically — the operator must pick a fresh asSlug.
          console.info(
            JSON.stringify({
              level: 'info',
              msg: 'slug_validation_failed',
              reason: originalCheck.reason,
              candidate: originalSlug,
              context: 'restore_original',
            }),
          )
          throw new HttpError(422, 'slug_invalid')
        }
      }

      // Step 3a: collision check on target slug against a live row.
      // Empty asSlug + an original slug already claimed by another
      // live page surfaces as 409 slug_taken; the FE prompts the
      // operator to retry with `asSlug = {originalSlug}-restored-{hash}`.
      const [collision] = (await tx.execute(sql`
        SELECT id FROM pages
        WHERE slug = ${targetSlug}
          AND deleted_at IS NULL
          AND id <> ${id}
        FOR UPDATE
      `)) as unknown as [Array<{ id: number }>]
      if (collision.length > 0) {
        throw new HttpError(409, 'slug_taken')
      }

      // Step 3b: pre-check the slug_redirects collision BEFORE the row
      // mutation. If the rename would write a (resource_type='page',
      // old_slug=:originalSlug, new_slug=:targetSlug) row but another
      // resource_type already owns `originalSlug` as old_slug, the
      // INSERT below would trip `idx_slug_redirects_type_old`. Catching
      // it pre-UPDATE means the row's state and audit log stay
      // consistent regardless of TX rollback semantics — the operator
      // observes "this was rejected" instead of "this happened then
      // didn't." Locks the candidate redirect rows in deterministic id
      // order to serialise behind any concurrent cross-resource rename.
      if (renamed) {
        const [crossType] = (await tx.execute(sql`
          SELECT id FROM slug_redirects
          WHERE old_slug = ${originalSlug}
          ORDER BY id ASC
          FOR UPDATE
        `)) as unknown as [Array<{ id: number }>]
        if (crossType.length > 0) {
          throw new HttpError(409, 'slug_redirect_collision')
        }
      }

      // Step 4: restore. Clears deleted_at, sets slug=targetSlug,
      // published=0, published_at=NULL (so a subsequent republish
      // stamps a fresh date), is_home=0 (defensive against legacy
      // pre-rev-4 rows that may still hold is_home=1 in trash), bumps
      // preview_epoch. version+1 keeps the optimistic-lock token moving.
      await tx.execute(sql`
        UPDATE pages
        SET deleted_at = NULL,
            slug = ${targetSlug},
            published = 0,
            published_at = NULL,
            is_home = 0,
            preview_epoch = preview_epoch + 1,
            version = version + 1,
            updated_by = ${ctx.userId}
        WHERE id = ${id}
      `)

      // Step 5: optional slug_redirects write when restored under a
      // different slug. Inbound bookmarks for the original slug get
      // redirected to the new location. The §1.4 step 9 unique index
      // on (resource_type, old_slug) catches any collision (another
      // page already owns the originalSlug as old_slug) — surfaces
      // via isDuplicateKey catch as 409 slug_redirect_collision.
      if (renamed) {
        await tx.execute(sql`
          INSERT INTO slug_redirects (resource_type, old_slug, new_slug)
          VALUES ('page', ${originalSlug}, ${targetSlug})
        `)
      }

      // Step 6: audit.
      await tx.insert(auditLog).values({
        userId: ctx.userId,
        tokenId: ctx.tokenId,
        action: 'restore',
        resourceType: 'page',
        resourceId: String(id),
        diff: {
          kind: AUDIT_KIND.restore,
          slug: targetSlug,
          originalSlug,
          from_version: row.version,
        } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })

      // Step 7: revalidate.
      const tags = tagsForPageRestore(targetSlug, {
        oldSlug: renamed ? originalSlug : null,
        wasHome: row.is_home === 1,
      }).tags
      const queueRowId = await enqueueRevalidate(tx, tags)
      return {
        newVersion: row.version + 1,
        targetSlug,
        queueRowId,
        tags,
      }
    })

    queueMicrotask(() => {
      void drainRevalidate(txResult.queueRowId, txResult.tags)
    })

    return new Response(
      JSON.stringify({
        ok: true,
        slug: txResult.targetSlug,
        version: txResult.newVersion,
      }),
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
      // Disambiguate by constraint NAME. Two UNIQUE indexes can trip
      // here even after the explicit collision check:
      //   - idx_pages_slug — concurrent CREATE/restore claimed the
      //     target slug between our FOR UPDATE collision SELECT and
      //     the UPDATE that sets it. Surface as `slug_taken` so the
      //     FE rename-modal recovery flow fires (matches the
      //     single-row restore path that already keys on this code).
      //   - idx_slug_redirects_type_old — another page already owns
      //     the originalSlug as old_slug. Surface as
      //     `slug_redirect_collision` so the FE shows the "Another
      //     page's redirect already points at that web address" copy.
      // Match on err.message + sqlMessage so a driver swap that emits
      // the constraint name in one field but not the other still maps
      // correctly.
      const msg =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message: unknown }).message)
          : ''
      const sqlMsg =
        err && typeof err === 'object' && 'sqlMessage' in err
          ? String((err as { sqlMessage: unknown }).sqlMessage)
          : ''
      const haystack = `${msg} ${sqlMsg}`
      if (haystack.includes('idx_pages_slug')) {
        throw new HttpError(409, 'slug_taken')
      }
      // Default to slug_redirect_collision — covers
      // idx_slug_redirects_type_old and is the only OTHER unique key
      // a restore TX can plausibly trip.
      throw new HttpError(409, 'slug_redirect_collision')
    }
    throw err
  }
})

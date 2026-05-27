import { randomUUID } from 'node:crypto'
import { writeFile, rm } from 'node:fs/promises'
import { fileTypeFromBuffer } from 'file-type'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import {
  ipFromRequest,
  requireInstallToken,
  makeInstallLimit,
  refuseIfInstalled,
  checkRate,
  okJson,
  errJson,
  parseSettingsValue,
} from '@/lib/install/installEndpointHelpers'
import {
  PATHS,
  cleanupTmp,
  tmpDirFor,
  writeFinal,
} from '@/lib/media/storage'
import { processImage, MimeFormatMismatchError } from '@/lib/media/sharp'

// POST /api/install/logo — wizard branding step (OPTIONAL).
//
// Accepts a single image (JPEG / PNG / WebP / AVIF) up to 5 MB, runs
// it through the same sharp pipeline that the admin media upload uses
// (variants: thumb / md / lg / og + archived original), then writes
// the new media_id into settings.site_header.logo so the public site
// header renders the logo from then on. Also inserts a
// media_references row so the media can't be accidentally hard-
// deleted from /admin/media while the setting still points at it.
//
// DELETE /api/install/logo — clears settings.site_header.logo and
// soft-deletes the previously-uploaded media row. Wired to the X
// button on the Branding step's logo preview tile so the operator
// can change their mind before the wizard completes.
//
// Same gates as the rest of /api/install/*: install token + rate
// limit + refuse-if-installed. After the wizard completes, both
// methods permanently 410.
//
// Skips most of the heavy gates from /api/cms/media (no admin auth,
// no CSRF token — there is no admin session yet when this endpoint
// fires; the install-token gate is the auth). Image-only (no PDFs),
// small file cap, per-IP rate limit, per-process concurrency gate.

export const dynamic = 'force-dynamic'

const MAX_BYTES = 5 * 1024 * 1024 // 5 MB
const ALT_MAX = 320

const ALLOWED_IMG = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
])

const installLimit = makeInstallLimit('logo')

// In-process semaphore. The admin-side /api/cms/media uses the same
// pattern. An attacker holding the install token could otherwise fan
// out parallel multipart POSTs and OOM the worker (each materialises
// a 5 MB Buffer + a sharp pipeline at once).
let busyToken: symbol | null = null

interface InsertResult {
  insertId: number | bigint
}

function tooLarge(): Response {
  return new Response(JSON.stringify({ error: 'too_large' }), {
    status: 413,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function busy(): Response {
  return new Response(JSON.stringify({ error: 'busy' }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
      'retry-after': '5',
    },
  })
}

export const POST = withError(async (req: Request) => {
  const ip = ipFromRequest(req)
  const tokenFail = requireInstallToken(req)
  if (tokenFail) return tokenFail
  const refused = await refuseIfInstalled()
  if (refused) return refused

  // busyToken BEFORE rate limit: an over-eager double-click from the
  // wizard would otherwise burn the 5/300s install-limit bucket on
  // self-conflicts (UI gets 429 from us, then we also count the
  // attempt against the IP for the next 5min — a denial-of-self).
  // Reject concurrent fan-out first; ONLY count rate against
  // requests that actually got admitted.
  if (busyToken !== null) return busy()
  const myToken = Symbol('install-logo')
  busyToken = myToken
  const watchdog = setTimeout(() => {
    if (busyToken === myToken) busyToken = null
  }, 60_000)
  watchdog.unref()

  try {
    checkRate(installLimit, ip)

    const declared = Number(req.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > MAX_BYTES + 16 * 1024) {
      return tooLarge()
    }

    const form = await req.formData()
    const file = form.get('file')
    const altText = String(form.get('alt') ?? '').slice(0, ALT_MAX).trim()
    if (!altText) return errJson(400, 'alt_required')
    if (!(file instanceof File)) return errJson(400, 'file_required')

    const buf = Buffer.from(await file.arrayBuffer())
    if (buf.byteLength === 0) return errJson(400, 'empty_file')
    if (buf.byteLength > MAX_BYTES) return tooLarge()

    // Content sniff — never trust the client's content-type.
    const sniff = await fileTypeFromBuffer(buf)
    if (!sniff) return errJson(400, 'mime_unknown')
    if (!ALLOWED_IMG.has(sniff.mime)) return errJson(400, 'mime_rejected')

    const uuid = randomUUID()
    const tmpDir = await tmpDirFor(uuid)

    // Strip control chars AND path separators AND leading dots so a
    // file named "../../etc/passwd" doesn't survive into the
    // /admin/media display column. The renderer escapes HTML, but
    // path separators visible in the gallery would still mislead an
    // operator reading the original-name column.
    const safeOriginalName = file.name
      ? file.name
          .replace(/[\x00-\x1F\x7F]/g, '')
          .replace(/[/\\]/g, '_')
          .replace(/^\.+/, '_')
          .slice(0, 255)
      : null

    // Find an "earliest admin" user_id for uploaded_by. Comment is
    // intentional: at install time there is no session, so the audit
    // trail records the first admin (typically THE admin since
    // /api/install/admin-create only allows one). NULL is acceptable
    // if no admin exists yet (operator uploaded a logo BEFORE the
    // admin step). uploaded_by has ON DELETE SET NULL so a later
    // user soft-delete doesn't break the row.
    const [userRows] = (await db.execute(sql`
      SELECT id FROM users WHERE active = TRUE AND role = 'admin' ORDER BY id ASC LIMIT 1
    `)) as unknown as [Array<{ id: number }>]
    const uploaderId = userRows[0]?.id ?? null

    // INSERT media row with variants=NULL, then process to disk, then
    // UPDATE the row. Same shape as /api/cms/media for consistency.
    const [insertArr] = (await db.execute(sql`
      INSERT INTO media (filename_uuid, original_name, mime_type, alt_text, width, height, byte_size, uploaded_by)
      VALUES (${uuid}, ${safeOriginalName}, ${sniff.mime}, ${altText}, ${null}, ${null}, ${buf.byteLength}, ${uploaderId})
    `)) as unknown as [InsertResult]
    const mediaId = Number(insertArr.insertId)

    // The processImage + writeFile + writeFinal sequence has been
    // pulled out into its own try/catch so EVERY throw path soft-
    // deletes the media row (otherwise an orphan row with
    // variants=NULL would persist).
    try {
      let processed: Awaited<ReturnType<typeof processImage>>
      try {
        processed = await processImage(buf, tmpDir, uuid, sniff.mime)
      } catch (e) {
        if (e instanceof MimeFormatMismatchError) {
          await softDeleteMedia(mediaId)
          return errJson(400, 'mime_format_mismatch')
        }
        throw e
      }

      const { width, height, variants } = processed
      const tmpOriginal = `${tmpDir}/original`
      await writeFile(tmpOriginal, buf, { mode: 0o640 })

      const writtenFinals: string[] = []
      try {
        await writeFinal(tmpOriginal, `${PATHS.originals}/${uuid}`)
        writtenFinals.push(`${PATHS.originals}/${uuid}`)
        for (const v of ['thumb', 'md', 'lg'] as const) {
          const dest = `${PATHS.variants}/${uuid}-${v}.webp`
          await writeFinal(`${tmpDir}/${v}.webp`, dest)
          writtenFinals.push(dest)
        }
        const ogDest = `${PATHS.variants}/${uuid}-og.jpg`
        await writeFinal(`${tmpDir}/og.jpg`, ogDest)
        writtenFinals.push(ogDest)

        // Settings update + media_references upsert + media metadata
        // update — three statements that should land together. Wrap
        // in a transaction so a settings.value JSON write failure
        // doesn't leave a media row pointed-at by NOTHING but no
        // setting active.
        await db.transaction(async (tx) => {
          await tx.execute(sql`
            UPDATE media
            SET width = ${width}, height = ${height}, variants = ${JSON.stringify(variants)}
            WHERE id = ${mediaId}
          `)

          // Read existing site_header, swap in new logo mediaRef.
          const [existingHeaderRows] = (await tx.execute(sql`
            SELECT value FROM settings WHERE \`key\` = 'site_header'
          `)) as unknown as [Array<{ value: unknown }>]
          const existingHeader = parseSettingsValue(
            existingHeaderRows[0]?.value,
            'site_header',
          )

          // If a previous logo was uploaded in the same wizard run,
          // soft-delete it + drop its media_references row so the
          // user-facing /admin/media gallery doesn't show two near-
          // identical entries from a single install.
          const previousLogo = existingHeader.logo as
            | { media_id?: number }
            | null
            | undefined
          if (
            previousLogo &&
            typeof previousLogo.media_id === 'number' &&
            previousLogo.media_id !== mediaId
          ) {
            await tx.execute(sql`
              UPDATE media SET deleted_at = NOW(3) WHERE id = ${previousLogo.media_id}
            `)
            await tx.execute(sql`
              DELETE FROM media_references
              WHERE media_id = ${previousLogo.media_id}
                AND referent_type = 'settings'
                AND field = 'site_header.logo'
            `)
          }

          const merged: Record<string, unknown> = {
            brandText: existingHeader.brandText ?? 'Your Site',
            logo: { media_id: mediaId, alt: altText },
            theme: existingHeader.theme ?? 'cream',
            navItems: existingHeader.navItems ?? [],
            primaryCta: existingHeader.primaryCta ?? null,
          }
          await tx.execute(sql`
            INSERT INTO settings (\`key\`, value, version, updated_by)
            VALUES ('site_header', ${JSON.stringify(merged)}, 1, NULL)
            ON DUPLICATE KEY UPDATE
              value = VALUES(value),
              version = version + 1
          `)

          // Insert media_references so /api/cms/media/[id] refuses to
          // hard-delete the logo while the setting still binds it.
          // referent_id = 0 since the settings table is keyed by
          // string `key`, not int — every site_header.logo reference
          // shares this sentinel. The composite-PK guarantees
          // idempotency on re-upload.
          await tx.execute(sql`
            INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
            VALUES (${mediaId}, 'settings', 0, 'site_header.logo')
          `)
        })

        return okJson({ ok: true, mediaId, uuid, variants })
      } catch (renameErr) {
        // Roll back any successful renames so we don't leak files.
        for (const f of writtenFinals) {
          await rm(f, { force: true }).catch(() => {})
        }
        await softDeleteMedia(mediaId)
        throw renameErr
      }
    } catch (innerErr) {
      // Any throw not already handled above (incl. sharp panics,
      // disk-full mid-write) gets here. Soft-delete the row and
      // re-throw — withError will shape the 500.
      await softDeleteMedia(mediaId)
      throw innerErr
    } finally {
      await cleanupTmp(uuid).catch((err: unknown) => {
        console.warn(JSON.stringify({
          level: 'warn',
          msg: 'install_logo_cleanup_tmp_failed',
          uuid,
          mediaId,
          err: err instanceof Error ? err.message : String(err),
        }))
      })
    }
  } finally {
    clearTimeout(watchdog)
    if (busyToken === myToken) busyToken = null
  }
})

/**
 * DELETE /api/install/logo — clears settings.site_header.logo and
 * soft-deletes the previously-uploaded media row. Wired to the X
 * button on the wizard's Branding step. Refuses post-install like
 * the rest of /api/install/*.
 */
export const DELETE = withError(async (req: Request) => {
  const ip = ipFromRequest(req)
  const tokenFail = requireInstallToken(req)
  if (tokenFail) return tokenFail
  const refused = await refuseIfInstalled()
  if (refused) return refused

  // Share the same busyToken slot as POST — a parallel POST+DELETE
  // race would otherwise let DELETE soft-delete a media row that
  // POST's branding-seed transaction is about to bind. Sharing the
  // slot makes the two methods mutually-exclusive.
  if (busyToken !== null) return busy()
  const myToken = Symbol('install-logo-delete')
  busyToken = myToken
  const watchdog = setTimeout(() => {
    if (busyToken === myToken) busyToken = null
  }, 60_000)
  watchdog.unref()

  try {
    checkRate(installLimit, ip)

    await db.transaction(async (tx) => {
      const [existingHeaderRows] = (await tx.execute(sql`
        SELECT value FROM settings WHERE \`key\` = 'site_header' FOR UPDATE
      `)) as unknown as [Array<{ value: unknown }>]
      const existingHeader = parseSettingsValue(
        existingHeaderRows[0]?.value,
        'site_header',
      )
      const logo = existingHeader.logo as { media_id?: number } | null | undefined
      if (logo && typeof logo.media_id === 'number') {
        const mediaId = logo.media_id
        await tx.execute(sql`
          UPDATE media SET deleted_at = NOW(3) WHERE id = ${mediaId} AND deleted_at IS NULL
        `)
        await tx.execute(sql`
          DELETE FROM media_references
          WHERE media_id = ${mediaId}
            AND referent_type = 'settings'
            AND field = 'site_header.logo'
        `)
      }

      const cleared: Record<string, unknown> = {
        brandText: existingHeader.brandText ?? 'Your Site',
        logo: null,
        theme: existingHeader.theme ?? 'cream',
        navItems: existingHeader.navItems ?? [],
        primaryCta: existingHeader.primaryCta ?? null,
      }
      await tx.execute(sql`
        INSERT INTO settings (\`key\`, value, version, updated_by)
        VALUES ('site_header', ${JSON.stringify(cleared)}, 1, NULL)
        ON DUPLICATE KEY UPDATE
          value = VALUES(value),
          version = version + 1
      `)
    })

    return okJson({ ok: true })
  } finally {
    clearTimeout(watchdog)
    if (busyToken === myToken) busyToken = null
  }
})

async function softDeleteMedia(mediaId: number): Promise<void> {
  try {
    await db.execute(sql`UPDATE media SET deleted_at = NOW(3) WHERE id = ${mediaId}`)
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'install_logo_soft_delete_failed',
        mediaId,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

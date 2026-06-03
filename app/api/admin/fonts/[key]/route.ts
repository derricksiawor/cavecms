import { rm } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { getSetting } from '@/lib/cms/getSettings'
import { PATHS } from '@/lib/media/storage'
import { CUSTOM_FONT_KEY_RE, CUSTOM_FONT_FILE_RE } from '@/lib/typography/customFonts'
import { mutateCustomFonts } from '@/lib/typography/customFontsStore'

export const DELETE = withError(
  async (req: Request, { params }: { params: Promise<{ key: string }> }) => {
    const ctx = await requireRole(['admin'])
    await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })

    const { key } = await params
    if (!CUSTOM_FONT_KEY_RE.test(key)) throw new HttpError(400, 'bad_key')

    // Early 404 (best-effort); the atomic removal is inside the mutex below.
    const existing = await getSetting('custom_fonts')
    const font = existing.find((f) => f.key === key)
    if (!font) throw new HttpError(404, 'not_found')

    await mutateCustomFonts(ctx.userId, (cur) => cur.filter((f) => f.key !== key))

    // Best-effort binary cleanup. Re-validate the stored filename against the
    // strict pattern before joining — a tampered row must not delete outside
    // the fonts dir (safeJoin-style defence, even though PATHS.fonts is fixed).
    if (CUSTOM_FONT_FILE_RE.test(font.file)) {
      await rm(path.join(PATHS.fonts, font.file), { force: true }).catch(() => {})
    }

    return NextResponse.json({ ok: true })
  },
)

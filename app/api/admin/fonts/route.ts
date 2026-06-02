import { randomUUID } from 'node:crypto'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { getSetting } from '@/lib/cms/getSettings'
import { PATHS } from '@/lib/media/storage'
import { sniffFontFormat } from '@/lib/typography/fontFormat'
import { slugifyFamily, type CustomFont } from '@/lib/typography/customFonts'
import type { FontCategory } from '@/lib/typography/catalog'
import { mutateCustomFonts } from '@/lib/typography/customFontsStore'

// Operator-uploaded custom fonts. Session-admin only — requireCsrf rejects a
// bearer token (no CSRF header), so API tokens can't push binaries here. The
// font binary lands self-hosted under UPLOADS_ROOT/fonts and the metadata in
// the `custom_fonts` setting; the layout emits its @font-face on next render.
const MAX_FONT = 5 * 1024 * 1024
const FAMILY_MAX = 60
const MAX_FONTS = 50
const CATEGORIES = new Set(['serif', 'sans', 'display', 'mono'])

export const GET = withError(async () => {
  await requireRole(['admin'])
  const fonts = await getSetting('custom_fonts')
  return NextResponse.json({ fonts })
})

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })

  // Reject oversize bodies BEFORE buffering the whole upload into memory.
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_FONT + 64 * 1024) {
    throw new HttpError(413, 'file_too_large')
  }

  const form = await req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) throw new HttpError(400, 'file_required')
  const buf = Buffer.from(await file.arrayBuffer())
  if (buf.byteLength > MAX_FONT) throw new HttpError(413, 'file_too_large')

  // Trust the bytes, never the filename — sniff the real font signature.
  const sniff = sniffFontFormat(buf)
  if (!sniff) throw new HttpError(400, 'not_a_font')

  const family = String(form.get('family') ?? '').trim()
  if (family.length < 1 || family.length > FAMILY_MAX) {
    throw new HttpError(400, 'family_required')
  }
  const category = String(form.get('category') ?? 'sans')
  if (!CATEGORIES.has(category)) throw new HttpError(400, 'bad_category')
  const italic = String(form.get('italic') ?? '') === 'true'

  // Weights: a variable [min,max] range, or a single static weight (default 400).
  const wMin = Number(form.get('weightMin'))
  const wMax = Number(form.get('weightMax'))
  const wStatic = Number(form.get('staticWeight'))
  let weightRange: [number, number] | null = null
  let staticWeight: number | undefined
  if (Number.isFinite(wMin) && Number.isFinite(wMax) && wMin >= 1 && wMax >= wMin && wMax <= 1000) {
    weightRange = [Math.round(wMin), Math.round(wMax)]
  } else if (Number.isFinite(wStatic) && wStatic >= 1 && wStatic <= 1000) {
    staticWeight = Math.round(wStatic)
  } else {
    staticWeight = 400
  }

  // Early cap reject (best-effort — the atomic re-check is inside the mutex).
  if ((await getSetting('custom_fonts')).length >= MAX_FONTS) {
    throw new HttpError(400, 'too_many_fonts')
  }

  // cf-<slug>-<id> — slug ≤32, id 6 hex → comfortably within cf-[a-z0-9-]{1,48}.
  const slug = slugifyFamily(family) || 'font'
  const key = `cf-${slug}-${randomUUID().slice(0, 6)}`
  const fileName = `${key}${sniff.ext}`
  const font: CustomFont = {
    key,
    family,
    category: category as FontCategory, // validated against CATEGORIES above
    file: fileName,
    format: sniff.format,
    ...(weightRange ? { weightRange } : { staticWeight }),
    ...(italic ? { italic: true } : {}),
  }

  await mkdir(PATHS.fonts, { recursive: true, mode: 0o750 })
  await writeFile(path.join(PATHS.fonts, fileName), buf, { mode: 0o640 })

  // Atomic append (re-checks the cap under the mutex; revalidates on success).
  try {
    await mutateCustomFonts(ctx.userId, (cur) => {
      if (cur.length >= MAX_FONTS) throw new HttpError(400, 'too_many_fonts')
      return [...cur, font]
    })
  } catch (err) {
    // Lost the cap race (another upload filled the last slot) — drop the
    // orphaned file we just wrote, then surface the error.
    await rm(path.join(PATHS.fonts, fileName), { force: true }).catch(() => {})
    throw err
  }

  return NextResponse.json({ font })
})

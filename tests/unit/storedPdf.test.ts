import { describe, it, expect, vi, beforeEach } from 'vitest'

// db.execute returns [rows] (mysql2 tuple shape). One mock row drives each case.
const exec = vi.fn()
vi.mock('@/db/client', () => ({ db: { execute: (...a: unknown[]) => exec(...a) } }))
// storage.ts reads env.UPLOADS_ROOT at import — stub it to a fixed root so the
// module loads without a real env, and path building is deterministic.
vi.mock('@/lib/media/storage', () => ({
  PATHS: { brochures: '/srv/uploads/brochures-private' },
}))

import {
  checkStoredPdf,
  safeDownloadName,
  storedPdfPath,
  MAX_EMAIL_ATTACHMENT_BYTES,
} from '@/lib/media/storedPdf'

const row = (over: Record<string, unknown> = {}) => [
  [
    {
      filename_uuid: 'abc123',
      mime_type: 'application/pdf',
      byte_size: 1024,
      original_name: 'Forest Hill Brochure.pdf',
      ...over,
    },
  ],
]

describe('checkStoredPdf', () => {
  beforeEach(() => exec.mockReset())

  it('accepts a live PDF within the cap', async () => {
    exec.mockResolvedValue(row())
    const r = await checkStoredPdf(7, MAX_EMAIL_ATTACHMENT_BYTES)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.meta.filenameUuid).toBe('abc123')
      expect(r.meta.byteSize).toBe(1024)
    }
  })

  it('rejects a non-positive / non-integer id WITHOUT hitting the db', async () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      const r = await checkStoredPdf(bad, MAX_EMAIL_ATTACHMENT_BYTES)
      expect(r).toEqual({ ok: false, reason: 'missing' })
    }
    expect(exec).not.toHaveBeenCalled()
  })

  it('reports missing for an unknown/soft-deleted row', async () => {
    exec.mockResolvedValue([[]])
    expect(await checkStoredPdf(7, MAX_EMAIL_ATTACHMENT_BYTES)).toEqual({
      ok: false,
      reason: 'missing',
    })
  })

  it('reports missing for a tampered filename_uuid', async () => {
    exec.mockResolvedValue(row({ filename_uuid: '../etc/passwd' }))
    expect(await checkStoredPdf(7, MAX_EMAIL_ATTACHMENT_BYTES)).toEqual({
      ok: false,
      reason: 'missing',
    })
  })

  it('reports not_pdf for a non-PDF mime', async () => {
    exec.mockResolvedValue(row({ mime_type: 'image/png' }))
    expect(await checkStoredPdf(7, MAX_EMAIL_ATTACHMENT_BYTES)).toEqual({
      ok: false,
      reason: 'not_pdf',
    })
  })

  it('reports oversized at the exact boundary + 1', async () => {
    exec.mockResolvedValue(row({ byte_size: MAX_EMAIL_ATTACHMENT_BYTES + 1 }))
    const r = await checkStoredPdf(7, MAX_EMAIL_ATTACHMENT_BYTES)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('oversized')
  })

  it('accepts a file exactly at the cap', async () => {
    exec.mockResolvedValue(row({ byte_size: MAX_EMAIL_ATTACHMENT_BYTES }))
    expect((await checkStoredPdf(7, MAX_EMAIL_ATTACHMENT_BYTES)).ok).toBe(true)
  })
})

describe('safeDownloadName', () => {
  it('slugifies + forces .pdf', () => {
    expect(safeDownloadName('Forest Hill Brochure.pdf')).toBe('Forest Hill Brochure.pdf')
    // Path separators + glob chars are stripped (dots are allowed and harmless —
    // the on-disk path uses the regex-guarded filename_uuid, never this name).
    expect(safeDownloadName('weird/name*.pdf')).toBe('weirdname.pdf')
    expect(safeDownloadName(null)).toBe('download.pdf')
    expect(safeDownloadName('')).toBe('download.pdf')
  })
})

describe('storedPdfPath', () => {
  it('joins under the brochures dir with a .pdf extension', () => {
    expect(storedPdfPath('abc123')).toBe('/srv/uploads/brochures-private/abc123.pdf')
  })
})
